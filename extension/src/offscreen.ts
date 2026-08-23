import { VoiceActivityTracker, isChunkViable, blobToBase64 } from "./audioProcessing";
import { computeRms, shouldRunVadAnalysis } from "./vadTuning";
import { createOffscreenAudioGraph } from "./offscreenAudioGraph";
import {
  DRAIN_TIMEOUT_MS,
  MAX_BUFFER_MS,
  MAX_PENDING_CHUNKS,
  SILENCE_FLUSH_MS,
  VAD_SAMPLE_MS,
  MIN_CHUNK_BYTES,
  LEVEL_REPORT_MS,
  DEBUG,
} from "./config";

// ── State ────────────────────────────────────────────────────────────────────

let mediaStream: MediaStream | null = null;
let recorderStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let audioContext: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let vadTimer: ReturnType<typeof setInterval> | null = null;
let levelTimer: ReturnType<typeof setInterval> | null = null;
let isPaused = false;
let audioSource: MediaStreamAudioSourceNode | null = null;
let pendingChunks: Blob[] = [];
let isStopping = false;
let isDrainingQueue = false;
let isFlushInProgress = false;
let isVadBusy = false;
let silenceTicks = 0;
let speechActive = false;
let vadTickCounter = 0;
let bufferStartTime = 0;
let recorderMimeType = "";
let rmsThreshold = 0.012;
let analysisBuffer: Uint8Array<ArrayBuffer> | null = null;
let voiceActivity = new VoiceActivityTracker({ rmsThreshold });

const SILENCE_FLUSH_TICKS = Math.ceil(SILENCE_FLUSH_MS / VAD_SAMPLE_MS);

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(...a: unknown[]) {
  console.log("[LectureAI][offscreen]", ...a);
  if (DEBUG) {
    chrome.runtime.sendMessage({ type: "OFFSCREEN_LOG", message: a.join(" ") }).catch(() => {});
  }
}

function pickSupportedMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function getCurrentRms(): number {
  if (!analyserNode || !analysisBuffer) return 0;
  analyserNode.getByteTimeDomainData(analysisBuffer);
  return computeRms(analysisBuffer);
}

// ── Level metering ──────────────────────────────────────────────────────────
// The panel's equaliser bars used to be a CSS animation that ran whether or not
// any sound existed — which is the one thing a "we are listening" indicator must
// never do. These are the real levels off the same analyser the VAD uses.

/** RMS is tiny and logarithmic in feel; speech sits around 0.02–0.15. A square
 *  root spreads that across the bar's range so quiet speech is still visible. */
function levelFromRms(rms: number): number {
  const scaled = Math.sqrt(Math.min(1, rms / 0.22));
  return Math.round(Math.max(0, Math.min(1, scaled)) * 100) / 100;
}

function startLevelReports() {
  if (levelTimer) return;
  let lastSent = -1;
  levelTimer = setInterval(() => {
    const level = isPaused ? 0 : levelFromRms(getCurrentRms());
    // Skip identical frames — mostly silence — to keep the message bus quiet.
    if (level === lastSent) return;
    lastSent = level;
    chrome.runtime.sendMessage({ type: "OFFSCREEN_LEVEL", level }).catch(() => {});
  }, LEVEL_REPORT_MS);
}

function stopLevelReports() {
  if (levelTimer) { clearInterval(levelTimer); levelTimer = null; }
  chrome.runtime.sendMessage({ type: "OFFSCREEN_LEVEL", level: 0 }).catch(() => {});
}

// ── Chunk lifecycle ──────────────────────────────────────────────────────────

function handleRecorderDataAvailable(event: BlobEvent) {
  if (event.data && event.data.size > 0) {
    pendingChunks.push(event.data);
    if (pendingChunks.length >= MAX_PENDING_CHUNKS && mediaRecorder?.state === "recording") {
      log(`pendingChunks cap (${MAX_PENDING_CHUNKS}), pausing`);
      try { mediaRecorder.pause(); } catch {}
    }
  }
}

async function postChunk(blob: Blob) {
  if (!isChunkViable(blob, MIN_CHUNK_BYTES)) {
    log(`chunk too small (${blob.size}b), skipped`);
    return;
  }
  try {
    const audioBase64 = await blobToBase64(blob);
    const mimeType = mediaRecorder?.mimeType || "audio/webm";
    log(`sending chunk — ${blob.size}b ${mimeType}`);
    const resp = await chrome.runtime.sendMessage({
      type: "OFFSCREEN_AUDIO_CHUNK",
      audioBase64,
      mimeType,
    });
    if (!resp?.success) {
      log(`chunk rejected — ${resp?.error || "unknown"}`);
    }
  } catch (err) {
    console.error("[LectureAI][offscreen] send chunk failed:", err);
  }
}

async function drainPendingChunks() {
  if (isDrainingQueue) return;
  isDrainingQueue = true;
  try {
    while (pendingChunks.length > 0) {
      const blob = pendingChunks.shift();
      if (blob) await postChunk(blob);
    }
  } finally {
    isDrainingQueue = false;
    if (mediaRecorder?.state === "paused") {
      log("chunks drained, resuming");
      try { mediaRecorder.resume(); } catch {}
    }
  }
}

async function drainWithTimeout() {
  await Promise.race([
    drainPendingChunks(),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        if (pendingChunks.length > 0 || isDrainingQueue) {
          log(`drain timeout — dropping ${pendingChunks.length} chunks`);
          pendingChunks = [];
          isDrainingQueue = false;
        }
        resolve();
      }, DRAIN_TIMEOUT_MS),
    ),
  ]);
}

// ── Flush ────────────────────────────────────────────────────────────────────

function createRecorder(): MediaRecorder {
  if (!recorderStream) throw new Error("No active stream");
  const opts: MediaRecorderOptions = recorderMimeType
    ? { mimeType: recorderMimeType }
    : {};
  const r = new MediaRecorder(recorderStream, opts);
  r.addEventListener("dataavailable", handleRecorderDataAvailable);
  return r;
}

function stopRecorderAndAwaitData(recorder: MediaRecorder): Promise<void> {
  return new Promise((resolve) => {
    if (recorder.state === "inactive") { resolve(); return; }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      recorder.removeEventListener("dataavailable", onData);
      recorder.removeEventListener("stop", onStop);
      resolve();
    };
    const onData = () => finish();
    const onStop = () => finish();
    const tid = setTimeout(() => { log("recorder stop timeout"); finish(); }, 2000);
    recorder.addEventListener("dataavailable", onData, { once: true });
    recorder.addEventListener("stop", onStop, { once: true });
    try { recorder.stop(); } catch { finish(); }
  });
}

async function flushAudioChunk(force = false) {
  if (isFlushInProgress || !mediaRecorder || mediaRecorder.state !== "recording") return;
  isFlushInProgress = true;
  try {
    const hasSpeech = voiceActivity.consumeShouldFlush();
    if (!force && !hasSpeech) return;

    // Stop recorder so it emits a complete, self-contained WebM blob
    const prev = mediaRecorder;
    await stopRecorderAndAwaitData(prev);
    prev.removeEventListener("dataavailable", handleRecorderDataAvailable);

    if (isStopping || !recorderStream) { await drainWithTimeout(); return; }

    // Restart recorder for next segment
    try {
      mediaRecorder = createRecorder();
      mediaRecorder.start();
      bufferStartTime = Date.now();
    } catch (err) {
      log("recorder restart failed:", (err as Error).message);
      mediaRecorder = null;
      await stopCapture();
      return;
    }
    await drainWithTimeout();
  } finally {
    isFlushInProgress = false;
  }
}

// ── Capture lifecycle ────────────────────────────────────────────────────────

async function getTabAudioStream(streamId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      // @ts-expect-error chromeMediaSource is a Chrome-only constraint
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
    video: false,
  });
}

async function stopMediaRecorder() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  const r = mediaRecorder;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 2000);
    r.addEventListener("stop", () => { clearTimeout(t); resolve(); }, { once: true });
    r.addEventListener("error", () => { clearTimeout(t); resolve(); }, { once: true });
    try { r.stop(); } catch { resolve(); }
  });
}

function stopTracks(s: MediaStream | null) {
  s?.getTracks().forEach((t) => t.stop());
}

async function cleanupResources() {
  stopTracks(mediaStream);
  stopTracks(recorderStream);
  mediaStream = null;
  recorderStream = null;
  audioSource = null;
  if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
  stopLevelReports();
  isPaused = false;
  if (audioContext) {
    try { await audioContext.close(); } catch {}
    audioContext = null;
  }
  mediaRecorder = null;
  analyserNode = null;
  analysisBuffer = null;
  pendingChunks = [];
  isStopping = false;
  isVadBusy = false;
  silenceTicks = 0;
  speechActive = false;
  vadTickCounter = 0;
  bufferStartTime = 0;
  voiceActivity = new VoiceActivityTracker({ rmsThreshold });
}

async function startCapture(streamId: string, _tabId: number) {
  if (mediaRecorder?.state === "recording") {
    log("already capturing");
    return { success: true };
  }

  mediaStream = await getTabAudioStream(streamId);
  if (!mediaStream?.getAudioTracks().length) {
    throw new Error("No audio track in captured stream");
  }

  mediaStream.getAudioTracks()[0].onended = async () => {
    if (isStopping) return;
    log("audio track ended unexpectedly");
    await stopCapture();
    chrome.runtime.sendMessage({ type: "OFFSCREEN_CAPTURE_STOPPED", reason: "track_ended" }).catch(() => {});
  };

  audioContext = new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();

  const graph = createOffscreenAudioGraph(audioContext, mediaStream);
  analyserNode = graph.analyser;
  audioSource = graph.tabSource;
  recorderStream = graph.recorderDestination.stream;
  analysisBuffer = new Uint8Array(analyserNode.fftSize);

  recorderMimeType = pickSupportedMimeType();
  mediaRecorder = createRecorder();
  mediaRecorder.start(); // No timeslice — VAD controls flush

  voiceActivity = new VoiceActivityTracker({ rmsThreshold });
  silenceTicks = 0;
  speechActive = false;
  vadTickCounter = 0;
  bufferStartTime = Date.now();

  startLevelReports();

  vadTimer = setInterval(async () => {
    if (isStopping || isPaused || isVadBusy || isDrainingQueue) return;
    vadTickCounter++;
    const overflow = Date.now() - bufferStartTime >= MAX_BUFFER_MS;
    const runAnalysis = shouldRunVadAnalysis(speechActive, vadTickCounter);
    if (!runAnalysis && !overflow) return;

    isVadBusy = true;
    try {
      let naturalPause = false;
      let rms = -1;
      if (runAnalysis) {
        rms = getCurrentRms();
        voiceActivity.observe(rms);
        speechActive = rms >= rmsThreshold;
        if (speechActive) silenceTicks = 0;
        else silenceTicks++;
        naturalPause = silenceTicks >= SILENCE_FLUSH_TICKS;
      }
      if (naturalPause || overflow) {
        log(`flush — ${naturalPause ? "silence" : "overflow"} rms=${rms >= 0 ? rms.toFixed(4) : "n/a"}`);
        silenceTicks = 0;
        bufferStartTime = Date.now();
        await flushAudioChunk(overflow && !naturalPause);
      }
    } catch (err) {
      console.error("[LectureAI][offscreen] VAD error:", err);
    } finally {
      isVadBusy = false;
    }
  }, VAD_SAMPLE_MS);

  log(`capture started — mimeType=${recorderMimeType}`);
  return { success: true };
}

async function stopCapture() {
  if (isStopping) return;
  isStopping = true;
  try {
    if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
    await stopMediaRecorder();
    await drainPendingChunks();
  } catch (err) {
    console.error("[LectureAI][offscreen] stop failed:", err);
  }
  await cleanupResources();
}

// ── Message handlers ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type?.startsWith("OFFSCREEN_")) return false;

  (async () => {
    if (msg.type === "OFFSCREEN_PING") {
      sendResponse({ success: true });
      return;
    }
    if (msg.type === "OFFSCREEN_START_CAPTURE") {
      try {
        await startCapture(msg.streamId, msg.tabId);
        sendResponse({ success: true });
      } catch (err) {
        console.error("[LectureAI][offscreen] start failed:", err);
        sendResponse({ success: false, error: (err as Error).message });
      }
      return;
    }
    if (msg.type === "OFFSCREEN_PAUSE") {
      // Flush what's buffered first, so the pause doesn't strand half a
      // sentence in a chunk that only gets sent on resume.
      try {
        isPaused = true;
        if (mediaRecorder?.state === "recording") {
          await flushAudioChunk(true);
          mediaRecorder.pause();
        }
        sendResponse({ success: true });
      } catch (err) {
        isPaused = false;
        sendResponse({ success: false, error: (err as Error).message });
      }
      return;
    }
    if (msg.type === "OFFSCREEN_RESUME") {
      try {
        if (mediaRecorder?.state === "paused") mediaRecorder.resume();
        bufferStartTime = Date.now();
        silenceTicks = 0;
        speechActive = false;
        isPaused = false;
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: (err as Error).message });
      }
      return;
    }
    if (msg.type === "OFFSCREEN_STOP_CAPTURE") {
      if (isStopping) { sendResponse({ success: true, alreadyStopping: true }); return; }
      try {
        await stopCapture();
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: (err as Error).message });
      }
      return;
    }
    sendResponse({ success: false, error: "Unknown message" });
  })();

  return true; // keep sendResponse channel open
});
