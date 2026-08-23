// ── Lecture AI — Background Service Worker ──────────────────────────────
// Orchestrates: offscreen capture → backend transcription → transcript store → summary

import {
  BROADCAST_THROTTLE_MS,
  KEEPALIVE_INTERVAL_MS,
  INSIGHT_INTERVAL_MS,
  INSIGHT_WINDOW_MS,
  INSIGHT_MIN_NEW_CHARS,
  ASK_CONTEXT_CHARS,
  QUESTION_EXCLUDE_LIMIT,
  QUESTION_INVITE_CUES,
  INVITE_COOLDOWN_MS,
  PROF_PIN_CUES,
  PIN_COOLDOWN_MS,
  PIN_LIMIT,
  FLAG_WINDOW_MS,
  FLAG_LIMIT,
  FLAG_DEDUPE_MS,
  FLAG_EXPLAIN_LIMIT,
  FLAG_EXPLAIN_CONTEXT_CHARS,
  TRANSCRIPTION_CONCURRENCY,
  FIRST_INSIGHT_DELAY_MS,
  FIRST_INSIGHT_MIN_CHARS,
  CHUNK_MAX_ATTEMPTS,
  CHUNK_RETRY_BASE_MS,
  HISTORY_LIMIT,
  DEBUG,
} from "./config";
import type {
  LectureSession,
  TranscriptSegment,
  LectureInsights,
  InsightsResponse,
  SummaryDoc,
  HistoryEntry,
  StudentFlag,
  ProfPin,
  HealthReport,
  BackgroundToPopup,
} from "./types";
import {
  loadSettings,
  canGoDirect,
  canTranscribeDirect,
  SETTINGS_KEY,
  type Settings,
} from "./settings";
import { transcribeDirect, geminiDirect, parseJsonLoose } from "./apiDirect";
import {
  INSIGHTS_SYSTEM_PROMPT,
  ASK_SYSTEM_PROMPT,
  EXPLAIN_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
} from "./prompts";

// ── State ────────────────────────────────────────────────────────────────────

let session: LectureSession | null = null;
let offscreenReady = false;
let offscreenCreating = false;
let keepAliveAlarmName = "lecture-ai-keepalive";
const INSIGHT_ALARM = "lecture-ai-insights";
let lastBroadcast = 0;
/** When the current pause began, so elapsed time can exclude it. */
let pausedAt = 0;
/** `attempts` is what turns this from a fire-and-forget queue into a retrying
 *  one — a chunk that fails transcription goes back in line instead of leaving
 *  a permanent hole in the transcript. */
let transcriptionQueue: {
  base64: string;
  mimeType: string;
  timestamp: number;
  attempts: number;
}[] = [];
let activeTranscriptions = 0;
let isThinking = false;
/** Transcript length at the last insight call — used to skip idle windows. */
let lastInsightChars = 0;
const LAST_SESSION_KEY = "lecture_ai_last_session_id";
const INSIGHTS_KEY = "lecture_ai_live_insights";
/** The in-flight session, mirrored to chrome.storage.session. MV3 kills this
 *  worker after ~30s idle and every `let` above goes with it — the keepalive
 *  alarm can't prevent it because chrome.alarms has a 1-minute floor. So the
 *  live session is treated as storage-backed, not memory-backed. Without this,
 *  the first eviction mid-lecture silently freezes insights and empties the ask
 *  box while the panel keeps ticking and still looks alive. */
const LIVE_SESSION_KEY = "lecture_ai_live_session";
/** Last time we told the panel the professor invited questions. */
let lastInviteAt = 0;
/** Last time an assessment cue fired. See PIN_COOLDOWN_MS. */
let lastPinAt = 0;
/** Most recent transcription failure this session, for the health dot. Kept in
 *  memory only: a stale error surviving a worker restart would make a working
 *  setup look broken. */
let lastChunkError = "";
const HISTORY_KEY = "lecture_ai_history";
/** Settings are read on nearly every call; cache until something changes. */
let cachedSettings: Settings | null = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SETTINGS_KEY]) cachedSettings = null;
});

async function settingsNow(): Promise<Settings> {
  if (!cachedSettings) cachedSettings = await loadSettings();
  return cachedSettings;
}


function log(...a: unknown[]) {
  console.log("[LectureAI][bg]", ...a);
}

// ── Session persistence (survives service worker eviction) ──────────────────

/** Mirror the live session so a restarted worker can pick it back up. */
async function persistSession(): Promise<void> {
  if (!session) return;
  try {
    await chrome.storage.session.set({ [LIVE_SESSION_KEY]: session });
  } catch {
    // storage.session has a small quota; a long transcript can overflow it.
    // Segments are already durable under session_<id>_segments, so drop them
    // from the mirror rather than losing the session identity.
    try {
      await chrome.storage.session.set({
        [LIVE_SESSION_KEY]: { ...session, segments: [] },
      });
    } catch { /* give up quietly — next tick will retry */ }
  }
}

/** Call at the top of anything that touches `session`. Rehydrates after the
 *  worker has been evicted and restarted mid-lecture. */
async function ensureSession(): Promise<LectureSession | null> {
  if (session) return session;
  try {
    const stored = await chrome.storage.session.get(LIVE_SESSION_KEY);
    const revived = stored[LIVE_SESSION_KEY] as LectureSession | undefined;
    if (!revived) return null;

    // Segments live in local storage and may be ahead of the mirror.
    const segs = await chrome.storage.local.get(`session_${revived.id}_segments`);
    revived.segments = segs[`session_${revived.id}_segments`] || revived.segments || [];

    // Flags are the student's own work — the one thing in here that cannot be
    // regenerated — so they get their own durable key and win over the mirror.
    const fl = await chrome.storage.local.get(`session_${revived.id}_flags`);
    revived.flags = fl[`session_${revived.id}_flags`] || revived.flags || [];
    revived.pins = revived.pins || [];

    const ins = await chrome.storage.local.get(INSIGHTS_KEY);
    if (ins[INSIGHTS_KEY] && !revived.insights) revived.insights = ins[INSIGHTS_KEY];

    session = revived;
    lastInsightChars = session.segments.reduce((t, x) => t + x.text.length, 0);
    log("session rehydrated after worker restart —", session.id);

    // The insight chain died with the old worker; restart it.
    if (session.status === "capturing") scheduleInsightRun();
    return session;
  } catch (err) {
    console.warn("[LectureAI][bg] rehydrate failed:", err);
    return null;
  }
}

async function clearPersistedSession(): Promise<void> {
  await chrome.storage.session.remove(LIVE_SESSION_KEY).catch(() => {});
}

// ── "Any questions?" detection ──────────────────────────────────────────────

/** Cheap string match — the professor opening the floor is the single moment
 *  this product exists for, and waiting on a 75s model cycle to notice it would
 *  miss it entirely. */
function detectQuestionInvite(text: string): string | null {
  const hay = text.toLowerCase();
  for (const cue of QUESTION_INVITE_CUES) {
    if (hay.includes(cue)) return cue;
  }
  return null;
}

function maybeAnnounceInvite(text: string): void {
  const cue = detectQuestionInvite(text);
  if (!cue) return;
  if (Date.now() - lastInviteAt < INVITE_COOLDOWN_MS) return;
  lastInviteAt = Date.now();
  log("professor invited questions —", cue);
  broadcast({ type: "QUESTIONS_INVITED", heard: cue });

  // If the questions on screen are stale, quietly get fresh ones. The panel is
  // already showing the old ones, so this is an upgrade, not a blocking wait.
  if (!isThinking) refreshInsights();
}

// ── Assessment mentions ("don't miss this") ─────────────────────────────────

/** Same cheap-match trick as the invite cues, aimed at a different problem: a
 *  quiz date or a submission deadline said once, in passing, between two slides.
 *  Deliberately not a model judgement — "was that important?" is exactly the
 *  call an LLM makes inconsistently, and a list you can't trust to be complete
 *  is a list you have to double-check anyway, which defeats the point. */
function detectProfPin(text: string): string | null {
  const hay = text.toLowerCase();
  for (const cue of PROF_PIN_CUES) {
    if (hay.includes(cue)) return cue;
  }
  return null;
}

function maybePinProfMention(segment: TranscriptSegment): void {
  if (!session) return;
  const cue = detectProfPin(segment.text);
  if (!cue) return;

  const pins = (session.pins ??= []);
  if (pins.length >= PIN_LIMIT) return;
  // One policy explanation trips several cues in a row; that's one moment.
  if (Date.now() - lastPinAt < PIN_COOLDOWN_MS) return;
  // Deepgram occasionally re-emits an overlapping tail. Don't pin it twice.
  if (pins.some((p) => p.text === segment.text)) return;

  lastPinAt = Date.now();
  const pin: ProfPin = {
    id: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    at: segment.startTime,
    cue,
    text: segment.text,
  };
  pins.push(pin);
  log("assessment mention pinned —", cue);
  broadcast({ type: "PIN_ADDED", pin });
}

// ── Student flags ("I'm lost") ──────────────────────────────────────────────

/** The one signal no model can produce. "I stopped following here" is a fact
 *  about the student, not about the lecture, and it's the highest-quality input
 *  this product ever receives — so the cost of giving it is one tap and the
 *  student never has to type why. */
function transcriptAround(s: LectureSession, at: number, windowMs: number): string {
  const from = at - windowMs;
  const near = s.segments.filter((seg) => seg.endTime >= from && seg.startTime <= at + 2_000);
  // Nothing transcribed yet in that window — fall back to the last thing said,
  // so a flag is never empty and therefore never useless.
  const use = near.length ? near : s.segments.slice(-2);
  return use.map((seg) => seg.text).join(" ").trim();
}

async function flagNow(): Promise<{ ok: boolean; flag?: StudentFlag; error?: string }> {
  if (!session) await ensureSession();
  if (!session) return { ok: false, error: "No lecture running" };

  const flags = (session.flags ??= []);
  if (flags.length >= FLAG_LIMIT) return { ok: false, error: "Flag limit reached" };

  const at = Date.now();

  // Two flags a second apart describe the same 45 seconds of audio, so the
  // second one is worthless by construction. This also makes it safe for the
  // popup and the panel to handle Alt+L themselves alongside the browser-level
  // command — a double delivery reports success without duplicating anything.
  const last = flags[flags.length - 1];
  if (last && at - last.at < FLAG_DEDUPE_MS) return { ok: true, flag: last };

  const flag: StudentFlag = {
    id: `flg_${at}_${Math.random().toString(36).slice(2, 6)}`,
    at,
    text: transcriptAround(session, at, FLAG_WINDOW_MS) || "(nothing transcribed yet)",
    source: "live",
  };
  flags.push(flag);
  await persistSession();
  await chrome.storage.local.set({ [`session_${session.id}_flags`]: flags });
  broadcast({ type: "FLAGS_UPDATE", flags });
  return { ok: true, flag };
}

/** Flag or unflag one transcript line. Works on a finished lecture too, which is
 *  when most flagging actually happens — you skim the transcript afterwards and
 *  mark the three places you'd want re-explained. */
async function toggleFlag(
  sessionId: string | undefined,
  at: number,
  text: string
): Promise<{ ok: boolean; flags?: StudentFlag[]; flagged?: boolean; error?: string }> {
  if (!text.trim()) return { ok: false, error: "Nothing to flag" };

  // Live session if this is it, otherwise the stored copy.
  if (!session) await ensureSession();
  const isLive = !!session && (!sessionId || sessionId === session.id);
  const target: LectureSession | null = isLive
    ? session
    : ((await chrome.storage.local.get(`session_${sessionId}`))[`session_${sessionId}`] ?? null);
  if (!target) return { ok: false, error: "Lecture not found" };

  const flags = (target.flags ??= []);
  const existing = flags.findIndex((f) => f.at === at && f.text === text);

  let flagged: boolean;
  if (existing >= 0) {
    flags.splice(existing, 1);
    flagged = false;
  } else {
    if (flags.length >= FLAG_LIMIT) return { ok: false, error: "Flag limit reached" };
    flags.push({
      id: `flg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      at,
      text,
      source: "transcript",
    });
    flags.sort((a, b) => a.at - b.at);
    flagged = true;
  }

  if (isLive) {
    await persistSession();
    await chrome.storage.local.set({ [`session_${target.id}_flags`]: flags });
  } else {
    await chrome.storage.local.set({ [`session_${target.id}`]: target });
  }
  broadcast({ type: "FLAGS_UPDATE", flags });
  return { ok: true, flags, flagged };
}

/** Fill in the plain-language re-explanation for each flag that lacks one.
 *  Runs on demand from the summary page rather than automatically at stop:
 *  flags added while reading the transcript arrive after the lecture ends, so
 *  "explain them all now" has to be a thing the student can ask for twice. */
async function explainFlags(
  sessionId: string
): Promise<{ ok: boolean; flags?: StudentFlag[]; error?: string }> {
  if (!session) await ensureSession();
  const isLive = !!session && sessionId === session.id;
  const target: LectureSession | null = isLive
    ? session
    : ((await chrome.storage.local.get(`session_${sessionId}`))[`session_${sessionId}`] ?? null);
  if (!target) return { ok: false, error: "Lecture not found" };

  const flags = target.flags ?? [];
  const pending = flags.filter((f) => !f.explanation).slice(0, FLAG_EXPLAIN_LIMIT);
  if (!pending.length) return { ok: true, flags };

  const full = target.segments.map((s) => s.text).join(" ");

  // Sequential on purpose. Firing eight Gemini calls at once is the fastest way
  // to collect eight 429s on a free key, and the student is reading the page
  // top-down anyway.
  for (const flag of pending) {
    const anchor = full.indexOf(flag.text.slice(0, 60));
    const context =
      anchor >= 0
        ? full.slice(
            Math.max(0, anchor - FLAG_EXPLAIN_CONTEXT_CHARS),
            anchor + flag.text.length + 600
          )
        : full.slice(-FLAG_EXPLAIN_CONTEXT_CHARS);
    try {
      const answer = await callModel({
        system: EXPLAIN_SYSTEM_PROMPT,
        user:
          `Mode: SIMPLER\n\nHighlighted passage:\n"${flag.text}"\n\n` +
          `Surrounding transcript for context:\n${context || "(no further context available)"}`,
        route: "/api/explain",
        body: { passage: flag.text, context, mode: "simpler" },
        temperature: 0.3,
        maxOutputTokens: 400,
        pick: (d) => d?.answer || "",
      });
      if (answer.trim()) flag.explanation = answer.trim();
    } catch (err) {
      // One failed explanation shouldn't cost the student the other seven.
      console.warn("[LectureAI][bg] flag explain failed:", err);
    }
  }

  if (isLive) await persistSession();
  await chrome.storage.local.set({ [`session_${target.id}`]: target });
  broadcast({ type: "FLAGS_UPDATE", flags });
  return { ok: true, flags };
}

/** Three facts, no score — see HealthReport. The popup turns these into one dot
 *  plus one line of text, so "no keys" and "falling behind" read differently. */
async function healthReport(): Promise<HealthReport> {
  const s = await settingsNow();
  const mode: HealthReport["mode"] = canTranscribeDirect(s)
    ? "direct"
    : s.backendUrl
    ? "proxy"
    : "none";
  return {
    mode,
    queued: transcriptionQueue.length,
    active: activeTranscriptions,
    ...(lastChunkError ? { lastError: lastChunkError } : {}),
  };
}

// ── Offscreen management ─────────────────────────────────────────────────────

async function ensureOffscreen(): Promise<void> {
  if (offscreenReady) return;
  if (offscreenCreating) {
    // Wait for creation to finish
    for (let i = 0; i < 50 && !offscreenReady; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (offscreenReady) return;
  }

  offscreenCreating = true;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS", "USER_MEDIA"],
      justification: "Capture tab audio for lecture transcription",
    });
  } catch (e: any) {
    if (!e.message?.includes("Only a single offscreen")) throw e;
  }
  offscreenCreating = false;

  // Poll until ready
  for (let i = 0; i < 30 && !offscreenReady; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ type: "OFFSCREEN_PING" });
      if (r?.success) { offscreenReady = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!offscreenReady) throw new Error("Offscreen document not ready");
}

function sendToOffscreen(msg: Record<string, unknown>): Promise<any> {
  // chrome.runtime.sendMessage() already returns a promise that resolves
  // with whatever the offscreen document's sendResponse() call passed —
  // there is no need (and no working mechanism) to correlate a separate
  // broadcast message. We just race it against a timeout.
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Offscreen response timeout")), 15_000);
  });
  return Promise.race([chrome.runtime.sendMessage(msg), timeout]);
}

// ── Keep-alive (prevent MV3 service worker suspension) ───────────────────────

function startKeepAlive() {
  chrome.alarms.create(keepAliveAlarmName, {
    delayInMinutes: KEEPALIVE_INTERVAL_MS / 60_000,
    periodInMinutes: KEEPALIVE_INTERVAL_MS / 60_000,
  });
}

function stopKeepAlive() {
  chrome.alarms.clear(keepAliveAlarmName).catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  // An alarm may be what woke this worker from the dead, so rehydrate before
  // testing session state — the old code read a null `session` here and then
  // silently stopped refreshing for the rest of the lecture.
  (async () => {
    await ensureSession();

    if (alarm.name === keepAliveAlarmName &&
        (session?.status === "capturing" || session?.status === "paused")) {
      if (DEBUG) log("keep-alive ping");
      chrome.storage.session.set({ _ping: Date.now() }).catch(() => {});
    }

    if (alarm.name === INSIGHT_ALARM) {
      // One-shot alarm: run, then reschedule. chrome.alarms clamps periodic
      // alarms to a 1-minute floor, so self-rescheduling keeps our cadence.
      try {
        await refreshInsights();
      } finally {
        if (session?.status === "capturing") scheduleInsightRun();
      }
    }
  })();
});

// ── Broadcast state to popup / tabs ──────────────────────────────────────────

function broadcast(msg: BackgroundToPopup) {
  const now = Date.now();
  if (now - lastBroadcast < BROADCAST_THROTTLE_MS && msg.type === "STATUS_UPDATE") return;
  lastBroadcast = now;

  // Popup
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ── Session helpers ──────────────────────────────────────────────────────────

function generateId(): string {
  return `lec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createSession(tabId: number, tabUrl: string): LectureSession {
  return {
    id: generateId(),
    tabId,
    tabUrl,
    status: "starting",
    startTime: Date.now(),
    segments: [],
    flags: [],
    pins: [],
  };
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString("en-IN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function elapsed(): string {
  if (!session?.startTime) return "0:00";
  const s = Math.floor((Date.now() - session.startTime) / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// ── Transcription (via backend proxy → Deepgram) ────────────────────────────

async function transcribeChunk(base64: string, mimeType: string): Promise<string> {
  const s = await settingsNow();

  // BYOK path — no local server needed at all.
  if (canTranscribeDirect(s)) {
    const { text } = await transcribeDirect(base64, mimeType, s);
    return text;
  }

  const resp = await fetch(`${s.backendUrl}/api/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // keywords ride along so the proxy can boost them too — the same course
    // vocabulary should help whichever path the audio takes.
    body: JSON.stringify({ audio: base64, mimeType, keywords: s.keywords }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Transcription API ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  return data.text || "";
}

/** One place that decides between "call Gemini directly with the user's key"
 *  and "ask the local proxy to do it". Every model feature goes through here. */
async function callModel(opts: {
  system: string;
  user: string;
  route: string;
  body: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  json?: boolean;
  /** Pull the text out of the proxy's JSON response. */
  pick: (data: any) => string;
}): Promise<string> {
  const s = await settingsNow();

  if (canGoDirect(s)) {
    return geminiDirect(
      {
        system: opts.system,
        user: opts.user,
        temperature: opts.temperature,
        maxOutputTokens: opts.maxOutputTokens,
        json: opts.json,
      },
      s
    );
  }

  const resp = await fetch(`${s.backendUrl}${opts.route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...opts.body, language: s.outputLanguage }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${opts.route} ${resp.status}: ${text}`);
  }
  return opts.pick(await resp.json());
}

async function processTranscriptionWorker() {
  const item = transcriptionQueue.shift();
  if (!item) return;
  if (!session) await ensureSession();
  if (!session) return;
  activeTranscriptions++;

  try {
    const text = await transcribeChunk(item.base64, item.mimeType);
    if (!text.trim() || !session) return;

    const segment: TranscriptSegment = {
      id: `seg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      startTime: item.timestamp,
      endTime: Date.now(),
      text: text.trim(),
    };
    session.segments.push(segment);
    session.segments.sort((a, b) => a.startTime - b.startTime);

    await chrome.storage.local.set({
      [`session_${session.id}_segments`]: session.segments,
    });
    await persistSession();

    broadcast({ type: "TRANSCRIPT_UPDATE", segments: session.segments });

    // Did the professor just open the floor?
    maybeAnnounceInvite(segment.text);

    // Did they just mention a quiz, a deadline or what's on the exam?
    maybePinProfMention(segment);

    // A chunk landing successfully is the only honest way to clear the error —
    // the health dot should go green because it's working, not because time passed.
    lastChunkError = "";

    // Fire the very first insight as soon as there's anything worth reading.
    // Waiting for the full cadence leaves the panel blank through exactly the
    // window where someone decides whether this thing works.
    const chars = session.segments.reduce((n, s) => n + s.text.length, 0);
    if (!session.insights?.recap.length && chars >= FIRST_INSIGHT_MIN_CHARS && !isThinking) {
      refreshInsights();
    }
  } catch (err) {
    console.error("[LectureAI][bg] transcription error:", err);
    const attempts = item.attempts + 1;
    lastChunkError = (err as Error).message?.slice(0, 160) || "Transcription failed";

    if (attempts < CHUNK_MAX_ATTEMPTS) {
      // Put it back rather than losing that stretch of the lecture forever.
      // Re-queued at the front so the transcript stays roughly in order, after
      // a short back-off so a rate limit or a dropped socket has time to clear.
      const delay = CHUNK_RETRY_BASE_MS * attempts;
      log(`chunk retry ${attempts}/${CHUNK_MAX_ATTEMPTS} in ${delay}ms`);
      setTimeout(() => {
        transcriptionQueue.unshift({ ...item, attempts });
        processTranscriptionQueue();
      }, delay);
    } else {
      log(`chunk dropped after ${CHUNK_MAX_ATTEMPTS} attempts`);
      broadcast({
        type: "ERROR",
        message: `Transcription failed: ${(err as Error).message}`,
      });
    }
  } finally {
    activeTranscriptions--;
    processTranscriptionQueue();
  }
}

function processTranscriptionQueue() {
  while (
    activeTranscriptions < TRANSCRIPTION_CONCURRENCY &&
    transcriptionQueue.length > 0 &&
    session
  ) {
    processTranscriptionWorker();
  }
}

// ── Summarization (via backend proxy → Gemini) ───────────────────────────────

function asStr(v: unknown, max = 400): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function asList(v: unknown, max: number, chars = 300): string[] {
  return Array.isArray(v)
    ? v.map((x) => asStr(x, chars)).filter(Boolean).slice(0, max)
    : [];
}

/** The model is asked for JSON, but the panel and summary page render this
 *  straight to the DOM, so nothing is trusted on the way in. */
function normalizeSummaryDoc(parsed: any): SummaryDoc {
  return {
    generatedAt: Date.now(),
    title: asStr(parsed?.title, 90),
    tldr: asStr(parsed?.tldr, 700),
    keyPoints: asList(parsed?.keyPoints, 10),
    topics: Array.isArray(parsed?.topics)
      ? parsed.topics
          .map((t: any) => ({ topic: asStr(t?.topic, 90), detail: asStr(t?.detail, 900) }))
          .filter((t: any) => t.topic && t.detail)
          .slice(0, 12)
      : [],
    terms: Array.isArray(parsed?.terms)
      ? parsed.terms
          .map((t: any) => ({ term: asStr(t?.term, 70), meaning: asStr(t?.meaning, 240) }))
          .filter((t: any) => t.term && t.meaning)
          .slice(0, 20)
      : [],
    formulas: asList(parsed?.formulas, 12),
    examples: asList(parsed?.examples, 10),
    emphasis: asList(parsed?.emphasis, 8),
    openQuestions: asList(parsed?.openQuestions, 8),
    revise: asList(parsed?.revise, 8),
  };
}

/** Flat text version, for the clipboard and for anything that wants one string. */
function summaryDocToText(doc: SummaryDoc): string {
  const out: string[] = [];
  if (doc.title) out.push(`# ${doc.title}`);
  if (doc.tldr) out.push(doc.tldr);
  const section = (h: string, lines: string[]) => {
    if (lines.length) out.push(`## ${h}`, ...lines.map((l) => `- ${l}`));
  };
  section("Key points", doc.keyPoints);
  if (doc.topics.length) {
    out.push("## Topics covered");
    for (const t of doc.topics) out.push(`### ${t.topic}`, t.detail);
  }
  section("Terms", doc.terms.map((t) => `${t.term} — ${t.meaning}`));
  section("Formulas and rules", doc.formulas);
  section("Examples", doc.examples);
  section("The professor stressed", doc.emphasis);
  section("Left open", doc.openQuestions);
  section("Revise", doc.revise);
  return out.join("\n\n");
}

async function generateSummary(): Promise<{ text: string; doc: SummaryDoc }> {
  if (!session || session.segments.length === 0) {
    throw new Error("No transcript to summarize");
  }

  session.status = "summarizing";
  broadcast({ type: "STATUS_UPDATE", session: { ...session } });

  const transcriptText = session.segments
    .map((s) => `[${formatTimestamp(s.startTime)}] ${s.text}`)
    .join("\n");
  const maxChars = 30_000;
  const input =
    transcriptText.length > maxChars
      ? "...[earlier portion truncated]...\n" + transcriptText.slice(-maxChars)
      : transcriptText;

  const raw = await callModel({
    system: SUMMARY_SYSTEM_PROMPT,
    user: input,
    route: "/api/summarize",
    body: { transcript: input, structured: true },
    temperature: 0.15,
    maxOutputTokens: 2400,
    json: true,
    // A proxy that already returns a structured doc wins; otherwise fall back
    // to whatever text it sent so an older server still works.
    pick: (d) => (d?.doc ? JSON.stringify(d.doc) : d?.summary || ""),
  });

  const parsed = parseJsonLoose(raw);
  if (!parsed) {
    // Model ignored the schema — keep the prose rather than failing outright.
    const text = raw.trim();
    if (!text) throw new Error("Summary came back empty");
    return {
      text,
      doc: normalizeSummaryDoc({ title: "", tldr: text, keyPoints: [] }),
    };
  }

  const doc = normalizeSummaryDoc(parsed);
  return { text: summaryDocToText(doc), doc };
}

// ── History ─────────────────────────────────────────────────────────────────

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "lecture";
  }
}

/** Index a finished lecture so the history page can list it without loading
 *  every full transcript into memory. */
async function addToHistory(s: LectureSession): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(HISTORY_KEY);
    const list: HistoryEntry[] = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];

    const entry: HistoryEntry = {
      id: s.id,
      title: s.summaryDoc?.title || s.insights?.currentTopic || hostOf(s.tabUrl),
      tabUrl: s.tabUrl,
      startTime: s.startTime,
      endTime: s.endTime ?? Date.now(),
      segmentCount: s.segments.length,
      hasSummary: !!(s.summaryDoc || s.summary),
      topics: (s.insights?.coveredTopics ?? []).slice(-8),
      flagCount: s.flags?.length ?? 0,
      pinCount: s.pins?.length ?? 0,
    };

    const next = [entry, ...list.filter((e) => e.id !== s.id)].slice(0, HISTORY_LIMIT);
    await chrome.storage.local.set({ [HISTORY_KEY]: next });

    // Anything that fell off the end takes its transcript with it, otherwise
    // storage grows forever with lectures the user can no longer reach.
    for (const gone of list.filter((e) => !next.some((n) => n.id === e.id))) {
      await chrome.storage.local
        .remove([`session_${gone.id}`, `session_${gone.id}_segments`, `session_${gone.id}_flags`])
        .catch(() => {});
    }
  } catch (err) {
    console.warn("[LectureAI][bg] history write failed:", err);
  }
}

async function getHistory(): Promise<HistoryEntry[]> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
}

async function deleteHistoryEntry(sessionId: string) {
  const list = await getHistory();
  await chrome.storage.local.set({
    [HISTORY_KEY]: list.filter((e) => e.id !== sessionId),
  });
  await chrome.storage.local
    .remove([`session_${sessionId}`, `session_${sessionId}_segments`, `session_${sessionId}_flags`])
    .catch(() => {});
  return { ok: true };
}

// ── Live insights ────────────────────────────────────────────────────────────
// One periodic call powers every card in the side panel. It runs on a
// self-rescheduling alarm and caches its result, so the panel always has
// something to show instantly — you never wait on a model call when the
// professor has just called on you.

/** Transcript text for segments that started within the last `windowMs`. */
function recentTranscript(windowMs: number): string {
  if (!session) return "";
  const cutoff = Date.now() - windowMs;
  const recent = session.segments.filter((s) => s.startTime >= cutoff);
  // If the window is empty (long silence), fall back to the last few segments
  // so the card is never blank for lack of a technicality.
  const chosen = recent.length > 0 ? recent : session.segments.slice(-6);
  return chosen.map((s) => `[${formatTimestamp(s.startTime)}] ${s.text}`).join("\n");
}

function emptyInsights(): LectureInsights {
  return {
    updatedAt: Date.now(),
    currentTopic: null,
    recap: [],
    questions: [],
    terms: [],
    assumed: [],
    coveredTopics: [],
  };
}

async function persistInsights(insights: LectureInsights) {
  if (session) session.insights = insights;
  await chrome.storage.local.set({ [INSIGHTS_KEY]: insights }).catch(() => {});
  await persistSession();
  broadcast({ type: "INSIGHTS_UPDATE", insights });
}

function normalizeInsights(parsed: any): InsightsResponse {
  return {
    currentTopic: asStr(parsed?.currentTopic, 80) || null,
    recap: asList(parsed?.recap, 4),
    questions: Array.isArray(parsed?.questions)
      ? parsed.questions
          .map((q: any) => ({ question: asStr(q?.question, 220), basis: asStr(q?.basis, 120) }))
          .filter((q: any) => q.question)
          .slice(0, 3)
      : [],
    terms: Array.isArray(parsed?.terms)
      ? parsed.terms
          .map((t: any) => ({ term: asStr(t?.term, 60), meaning: asStr(t?.meaning, 160) }))
          .filter((t: any) => t.term && t.meaning)
          .slice(0, 4)
      : [],
    assumed: Array.isArray(parsed?.assumed)
      ? parsed.assumed
          .map((t: any) => ({ term: asStr(t?.term, 60), meaning: asStr(t?.meaning, 200) }))
          .filter((t: any) => t.term && t.meaning)
          .slice(0, 3)
      : [],
  };
}

async function callInsights(
  transcript: string,
  knownTopics: string[],
  excludeQuestions: string[] = []
): Promise<InsightsResponse> {
  const seen = knownTopics.slice(-8);
  const contextNote = seen.length
    ? `\n\nTopics already covered earlier in this lecture (do not repeat these as currentTopic unless the professor has genuinely returned to one): ${seen.join(", ")}`
    : "";
  const asked = excludeQuestions.filter(Boolean).slice(-8);
  const excludeNote = asked.length
    ? `\n\nThe student has already seen these questions and wants DIFFERENT ones. Do not repeat them or rephrase the same underlying point — find another angle in the transcript, or return an empty questions array if there genuinely isn't one:\n- ${asked.join("\n- ")}`
    : "";

  const raw = await callModel({
    system: INSIGHTS_SYSTEM_PROMPT,
    user: `Transcript of the last few minutes:\n\n${transcript}${contextNote}${excludeNote}`,
    route: "/api/insights",
    body: { transcript, knownTopics, excludeQuestions },
    // Nudge variety when the student explicitly asked for other questions.
    temperature: asked.length ? 0.75 : 0.25,
    maxOutputTokens: 1100,
    json: true,
    pick: (d) => JSON.stringify(d),
  });

  const parsed = parseJsonLoose(raw);
  if (!parsed) throw new Error("Model did not return usable JSON");
  return normalizeInsights(parsed);
}

/** Regenerate only the questions, keeping the recap and glossary untouched so
 *  the card you're mid-read of doesn't move. Excludes what's already on screen,
 *  so this gives alternatives rather than rephrasing the same thought. */
async function refreshQuestions(): Promise<{ ok: boolean; insights?: LectureInsights; error?: string }> {
  if (!session) await ensureSession();
  if (!session) return { ok: false, error: "No lecture running" };
  if (isThinking) return { ok: false, error: "Already thinking — try again in a second" };

  const transcript = recentTranscript(INSIGHT_WINDOW_MS);
  if (!transcript.trim()) return { ok: false, error: "Nothing said yet to build a question from" };

  const prev = session.insights ?? emptyInsights();
  isThinking = true;
  try {
    const data = await callInsights(
      transcript,
      prev.coveredTopics,
      prev.questions.map((q) => q.question).slice(-QUESTION_EXCLUDE_LIMIT)
    );
    const questions = Array.isArray(data.questions) ? data.questions.slice(0, 3) : [];
    if (questions.length === 0) {
      return { ok: false, error: "Nothing question-worthy in the last few minutes" };
    }
    const merged: LectureInsights = { ...prev, questions, updatedAt: Date.now() };
    await persistInsights(merged);
    return { ok: true, insights: merged };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    isThinking = false;
  }
}

function scheduleInsightRun(delayMs = INSIGHT_INTERVAL_MS) {
  chrome.alarms.create(INSIGHT_ALARM, { delayInMinutes: delayMs / 60_000 });
}

function stopInsightRuns() {
  chrome.alarms.clear(INSIGHT_ALARM).catch(() => {});
}

/** The rolling refresh. Cheap to skip, so it bails early when nothing is new. */
async function refreshInsights(): Promise<void> {
  if (!session) await ensureSession();
  if (!session || session.status !== "capturing") return;
  if (isThinking) return;

  const transcript = recentTranscript(INSIGHT_WINDOW_MS);
  if (!transcript.trim()) return;

  // Skip the call if the professor has barely said anything since last time.
  const totalChars = session.segments.reduce((n, s) => n + s.text.length, 0);
  if (totalChars - lastInsightChars < INSIGHT_MIN_NEW_CHARS && session.insights) return;

  isThinking = true;
  try {
    const prev = session.insights ?? emptyInsights();
    const data = await callInsights(transcript, prev.coveredTopics);
    lastInsightChars = totalChars;

    // Append the topic to history when it actually changes.
    const covered = [...prev.coveredTopics];
    const topic = data.currentTopic?.trim() || null;
    if (topic && covered[covered.length - 1] !== topic) covered.push(topic);

    await persistInsights({
      updatedAt: Date.now(),
      currentTopic: topic,
      recap: Array.isArray(data.recap) ? data.recap.slice(0, 4) : [],
      questions: Array.isArray(data.questions) ? data.questions.slice(0, 3) : [],
      terms: Array.isArray(data.terms) ? data.terms.slice(0, 4) : [],
      assumed: Array.isArray(data.assumed) ? data.assumed.slice(0, 3) : [],
      coveredTopics: covered.slice(-40),
    });
    if (DEBUG) log("insights refreshed —", topic);
  } catch (err) {
    // Insight failures are non-fatal: transcription keeps running and the panel
    // keeps showing the last good result.
    console.warn("[LectureAI][bg] insight refresh failed:", (err as Error).message);
  } finally {
    isThinking = false;
  }
}

/** Explicit "rewind N minutes" — a deeper recap for a window the user picked. */
async function catchMeUp(windowMinutes: number) {
  if (!session) return { ok: false, error: "Nothing is being captured right now" };
  const transcript = recentTranscript(windowMinutes * 60_000);
  if (!transcript.trim()) return { ok: false, error: "No speech captured in that window yet" };

  try {
    const prev = session.insights ?? emptyInsights();
    const data = await callInsights(transcript, prev.coveredTopics);
    const topic = data.currentTopic?.trim() || prev.currentTopic;
    const covered = [...prev.coveredTopics];
    if (topic && covered[covered.length - 1] !== topic) covered.push(topic);

    const insights: LectureInsights = {
      updatedAt: Date.now(),
      currentTopic: topic,
      recap: Array.isArray(data.recap) ? data.recap.slice(0, 5) : [],
      questions: Array.isArray(data.questions) ? data.questions.slice(0, 3) : prev.questions,
      terms: Array.isArray(data.terms) ? data.terms.slice(0, 4) : prev.terms,
      assumed: Array.isArray(data.assumed) ? data.assumed.slice(0, 3) : prev.assumed ?? [],
      coveredTopics: covered.slice(-40),
    };
    await persistInsights(insights);
    return { ok: true, insights };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Ad-hoc question against the transcript so far. */
async function askQuestion(question: string) {
  if (!question.trim()) return { ok: false, error: "Type a question first" };

  if (!session) await ensureSession();
  const source = session ?? (await loadLastSession());
  if (!source || source.segments.length === 0) {
    return { ok: false, error: "There's no transcript to answer from yet" };
  }

  const full = source.segments.map((s) => s.text).join(" ");
  const context = full.length > ASK_CONTEXT_CHARS ? full.slice(-ASK_CONTEXT_CHARS) : full;

  try {
    const answer = await callModel({
      system: ASK_SYSTEM_PROMPT,
      user: `Lecture transcript so far:\n\n${context}\n\n---\n\nStudent's question: ${question}`,
      route: "/api/ask",
      body: { question, transcript: context },
      temperature: 0.2,
      maxOutputTokens: 400,
      pick: (d) => d?.answer || "",
    });
    return { ok: true, answer: answer.trim() };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Highlight-to-explain. The student selected a line they didn't follow, so the
 *  passage is the question — surrounding transcript is only context. */
async function explainSelection(text: string, mode: "simpler" | "deeper") {
  const passage = text.trim();
  if (!passage) return { ok: false, error: "Select some text first" };

  if (!session) await ensureSession();
  const source = session ?? (await loadLastSession());
  const full = source ? source.segments.map((s) => s.text).join(" ") : "";
  // Anchor the passage in the transcript so the model can see what came before.
  const at = full.indexOf(passage.slice(0, 60));
  const context =
    at >= 0 ? full.slice(Math.max(0, at - 2500), at + passage.length + 1200) : full.slice(-3500);

  try {
    const answer = await callModel({
      system: EXPLAIN_SYSTEM_PROMPT,
      user:
        `Mode: ${mode.toUpperCase()}\n\nHighlighted passage:\n"${passage}"\n\n` +
        `Surrounding transcript for context:\n${context || "(no further context available)"}`,
      route: "/api/explain",
      body: { passage, context, mode },
      temperature: 0.3,
      maxOutputTokens: 500,
      pick: (d) => d?.answer || "",
    });
    return { ok: true, answer: answer.trim() };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ── Video deep-links ────────────────────────────────────────────────────────
// A transcript timestamp is wall-clock; a video position is a playhead. The gap
// between them is whatever the video was already at when capture started, so we
// record that once and do the arithmetic on click.

/** Largest <video> on the page — on a lecture page that's the lecture. */
function pickVideoTime(): number | null {
  const vids = Array.from(document.querySelectorAll("video"));
  if (!vids.length) return null;
  vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  return vids[0].currentTime;
}

async function readVideoTime(tabId: number): Promise<number | undefined> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pickVideoTime,
    });
    return typeof res?.result === "number" ? res.result : undefined;
  } catch {
    // No scripting access (chrome:// page, PDF, restricted host) — deep-links
    // just stay unavailable for this lecture.
    return undefined;
  }
}

async function seekTo(startTime: number) {
  if (!session) await ensureSession();
  const source = session ?? (await loadLastSession());
  if (!source) return { ok: false, error: "No lecture to seek in" };
  if (typeof source.videoStartAt !== "number") {
    return { ok: false, error: "No video was detected in this lecture's tab" };
  }

  const target = Math.max(0, source.videoStartAt + (startTime - source.startTime) / 1000);

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: source.tabId },
      func: (secs: number) => {
        const vids = Array.from(document.querySelectorAll("video"));
        if (!vids.length) return false;
        vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
        vids[0].currentTime = secs;
        return true;
      },
      args: [target],
    });
    if (!res?.result) return { ok: false, error: "That tab no longer has the video" };
    await chrome.tabs.update(source.tabId, { active: true }).catch(() => {});
    return { ok: true, seconds: target };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Could not reach that tab" };
  }
}

async function loadLastSession(): Promise<LectureSession | null> {
  const stored = await chrome.storage.local.get(LAST_SESSION_KEY);
  const id = stored[LAST_SESSION_KEY];
  if (!id) return null;
  const s = await chrome.storage.local.get(`session_${id}`);
  return s[`session_${id}`] || null;
}

// ── Side panel ───────────────────────────────────────────────────────────────

async function enableSidePanel(tabId: number) {
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: "pages/panel.html",
      enabled: true,
    });
  } catch (err) {
    log("side panel setOptions failed:", (err as Error).message);
  }
}

// ── Start lecture ────────────────────────────────────────────────────────────

async function startLecture() {
  if (session?.status === "capturing" || session?.status === "starting") {
    return { ok: false, error: "Lecture already in progress" };
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab?.url) {
      return { ok: false, error: "No active tab found" };
    }

    session = createSession(tab.id, tab.url);
    session.status = "starting";
    session.insights = emptyInsights();
    lastInsightChars = 0;
    await chrome.storage.local.remove(INSIGHTS_KEY).catch(() => {});
    await enableSidePanel(tab.id);
    broadcast({ type: "STATUS_UPDATE", session: { ...session } });

    await ensureOffscreen();

    // Get stream ID for the tab
    const streamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id! }, (id) => {
        const err = chrome.runtime.lastError;
        if (err || !id) reject(new Error(err?.message || "Failed to get stream ID"));
        else resolve(id!);
      });
    });

    // Start capture in offscreen
    const result = await sendToOffscreen({
      type: "OFFSCREEN_START_CAPTURE",
      streamId,
      tabId: tab.id,
    });

    if (!result?.success) {
      throw new Error(result?.error || "Offscreen capture failed");
    }

    session.status = "capturing";
    // Record where the video already was, so a transcript line can map back to
    // a playhead position later. Best-effort: many lecture pages allow it.
    session.videoStartAt = await readVideoTime(tab.id);
    await persistSession();
    startKeepAlive();
    scheduleInsightRun(FIRST_INSIGHT_DELAY_MS);
    broadcast({ type: "STATUS_UPDATE", session: { ...session } });
    log("lecture started — tab", tab.id, tab.url);

    return { ok: true };
  } catch (err: any) {
    const msg = err?.message || String(err);
    log("start failed:", msg);
    if (session) session.status = "error";
    broadcast({ type: "ERROR", message: msg });
    return { ok: false, error: msg };
  }
}

// ── Pause / resume ───────────────────────────────────────────────────────────
// Breaks happen. Stopping and restarting would split one lecture into two
// sessions with two transcripts; pausing keeps it as one.

async function pauseLecture() {
  if (!session) await ensureSession();
  if (!session || session.status !== "capturing") {
    return { ok: false, error: "Nothing is being captured right now" };
  }
  try {
    await sendToOffscreen({ type: "OFFSCREEN_PAUSE" });
    session.status = "paused";
    pausedAt = Date.now();
    stopInsightRuns();
    await persistSession();
    broadcast({ type: "STATUS_UPDATE", session: { ...session } });
    log("lecture paused");
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function resumeLecture() {
  if (!session) await ensureSession();
  if (!session || session.status !== "paused") {
    return { ok: false, error: "Nothing is paused" };
  }
  try {
    await sendToOffscreen({ type: "OFFSCREEN_RESUME" });
    session.status = "capturing";
    if (pausedAt) {
      session.pausedMs = (session.pausedMs ?? 0) + (Date.now() - pausedAt);
      pausedAt = 0;
    }
    scheduleInsightRun(FIRST_INSIGHT_DELAY_MS);
    await persistSession();
    broadcast({ type: "STATUS_UPDATE", session: { ...session } });
    log("lecture resumed");
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ── Stop lecture ─────────────────────────────────────────────────────────────

async function stopLecture() {
  if (!session) return { ok: false, error: "No active session" };

  try {
    session.status = "stopping";
    broadcast({ type: "STATUS_UPDATE", session: { ...session } });

    stopKeepAlive();
    stopInsightRuns();

    // Stop capture
    await sendToOffscreen({ type: "OFFSCREEN_STOP_CAPTURE" });

    // Wait for any pending transcription to finish
    for (let i = 0; i < 30 && (activeTranscriptions > 0 || transcriptionQueue.length > 0); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }

    session.endTime = Date.now();
    session.status = session.segments.length > 0 ? "transcribing" : "complete";
    await clearPersistedSession();

    if (session.status === "transcribing") {
      // Auto-generate summary if we have transcript
      try {
        const { text, doc } = await generateSummary();
        session.summary = text;
        session.summaryDoc = doc;
        session.status = "complete";
      } catch (err: any) {
        log("auto-summary failed:", err.message);
        session.status = "complete"; // transcript is still available
      }
    }

    // Persist full session
    await chrome.storage.local.set({
      [`session_${session.id}`]: session,
      [LAST_SESSION_KEY]: session.id,
    });
    await addToHistory(session);

    broadcast({ type: "STATUS_UPDATE", session: { ...session } });
    log("lecture stopped —", session.segments.length, "segments");

    const savedSession = session;
    session = null;
    return { ok: true, sessionId: savedSession.id };
  } catch (err: any) {
    const msg = err?.message || String(err);
    log("stop failed:", msg);
    if (session) session.status = "error";
    broadcast({ type: "ERROR", message: msg });
    return { ok: false, error: msg };
  }
}

// ── Retry summary ────────────────────────────────────────────────────────────

async function retrySummary(sessionId: string) {
  // Load session from storage
  const key = `session_${sessionId}`;
  const stored = await chrome.storage.local.get(key);
  const loaded: LectureSession | undefined = stored[key];
  if (!loaded) return { ok: false, error: "Session not found" };

  try {
    loaded.status = "summarizing";
    session = loaded;
    broadcast({ type: "STATUS_UPDATE", session: { ...session } });

    const { text, doc } = await generateSummary();
    session.summary = text;
    session.summaryDoc = doc;
    session.status = "complete";

    await chrome.storage.local.set({ [key]: session });
    await addToHistory(session);
    broadcast({ type: "SUMMARY_UPDATE", summary: session.summary });
    broadcast({ type: "STATUS_UPDATE", session: { ...session } });

    const savedSession = session;
    session = null;
    return { ok: true };
  } catch (err: any) {
    const msg = err?.message || String(err);
    session = session || loaded;
    session.status = "complete"; // keep transcript, just summary failed
    broadcast({ type: "ERROR", message: `Summary failed: ${msg}` });
    return { ok: false, error: msg };
  }
}

// ── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ── Messages from offscreen ───────────────────────────────────────────────
  if (msg?.type === "OFFSCREEN_READY") {
    offscreenReady = true;
    log("offscreen ready");
    return false;
  }

  if (msg?.type === "OFFSCREEN_LEVEL") {
    // Fire-and-forget: the panel may not be open, and a dropped frame of the
    // equaliser matters to nobody.
    chrome.runtime
      .sendMessage({ type: "AUDIO_LEVEL", level: msg.level } as BackgroundToPopup)
      .catch(() => {});
    return false;
  }

  if (msg?.type === "OFFSCREEN_AUDIO_CHUNK") {
    if (!session || !["capturing", "paused", "stopping"].includes(session.status)) {
      sendResponse({ success: false, error: "Not capturing" });
      return true;
    }
    transcriptionQueue.push({
      base64: msg.audioBase64,
      mimeType: msg.mimeType,
      timestamp: Date.now(),
      attempts: 0,
    });
    sendResponse({ success: true });
    processTranscriptionQueue();
    return true;
  }

  if (msg?.type === "OFFSCREEN_CAPTURE_STOPPED") {
    log("offscreen capture stopped — reason:", msg.reason);
    return false;
  }

  if (msg?.type === "OFFSCREEN_LOG") {
    if (DEBUG) log("[offscreen]", msg.message);
    return false;
  }

  // ── Messages from popup / pages ───────────────────────────────────────────
  (async () => {
    try {
      // The worker may have just been revived by this very message.
      if (!session && msg?.type !== "START_LECTURE") await ensureSession();

      if (msg?.type === "START_LECTURE") {
        sendResponse(await startLecture());
      } else if (msg?.type === "STOP_LECTURE") {
        sendResponse(await stopLecture());
      } else if (msg?.type === "GET_STATUS") {
        if (session) {
          sendResponse({ session: { ...session } });
        } else {
          const stored = await chrome.storage.local.get(LAST_SESSION_KEY);
          const lastSessionId = stored[LAST_SESSION_KEY];
          if (!lastSessionId) {
            sendResponse({ session: null });
            return;
          }
          const lastSession = await chrome.storage.local.get(`session_${lastSessionId}`);
          sendResponse({ session: lastSession[`session_${lastSessionId}`] || null });
        }
      } else if (msg?.type === "GET_SESSION") {
        // Load a saved session by ID
        const id = (msg as any).sessionId;
        if (!id) { sendResponse({ ok: false, error: "No sessionId" }); return; }
        const stored = await chrome.storage.local.get(`session_${id}`);
        sendResponse({ session: stored[`session_${id}`] || null });
      } else if (msg?.type === "GET_INSIGHTS") {
        if (session?.insights) {
          sendResponse({ insights: session.insights });
        } else {
          const stored = await chrome.storage.local.get(INSIGHTS_KEY);
          sendResponse({ insights: stored[INSIGHTS_KEY] || null });
        }
      } else if (msg?.type === "CATCH_ME_UP") {
        sendResponse(await catchMeUp(Number((msg as any).windowMinutes) || 5));
      } else if (msg?.type === "ASK_QUESTION") {
        sendResponse(await askQuestion(String((msg as any).question || "")));
      } else if (msg?.type === "REFRESH_QUESTIONS") {
        sendResponse(await refreshQuestions());
      } else if (msg?.type === "PAUSE_LECTURE") {
        sendResponse(await pauseLecture());
      } else if (msg?.type === "RESUME_LECTURE") {
        sendResponse(await resumeLecture());
      } else if (msg?.type === "EXPLAIN_SELECTION") {
        sendResponse(
          await explainSelection(
            String((msg as any).text || ""),
            (msg as any).mode === "deeper" ? "deeper" : "simpler"
          )
        );
      } else if (msg?.type === "SEEK_TO") {
        sendResponse(await seekTo(Number((msg as any).startTime) || 0));
      } else if (msg?.type === "GET_HISTORY") {
        sendResponse({ ok: true, history: await getHistory() });
      } else if (msg?.type === "DELETE_HISTORY_ENTRY") {
        sendResponse(await deleteHistoryEntry(String((msg as any).sessionId || "")));
      } else if (msg?.type === "GENERATE_SUMMARY") {

        if (session) {
          const { text, doc } = await generateSummary();
          session.summary = text;
          session.summaryDoc = doc;
          session.status = "complete";
          await chrome.storage.local.set({ [`session_${session.id}`]: session });
          await addToHistory(session);
          broadcast({ type: "SUMMARY_UPDATE", summary: session.summary });
          broadcast({ type: "STATUS_UPDATE", session: { ...session } });
          sendResponse({ ok: true, summary: session.summary, doc });
        } else {
          sendResponse({ ok: false, error: "No active session" });
        }
      } else if (msg?.type === "RETRY_SUMMARY") {
        const sid = (msg as any).sessionId;
        if (sid) sendResponse(await retrySummary(sid));
        else sendResponse({ ok: false, error: "No sessionId" });
      } else if (msg?.type === "FLAG_NOW") {
        sendResponse(await flagNow());
      } else if (msg?.type === "TOGGLE_FLAG") {
        sendResponse(
          await toggleFlag(
            (msg as any).sessionId || undefined,
            Number((msg as any).at) || 0,
            String((msg as any).text || "")
          )
        );
      } else if (msg?.type === "EXPLAIN_FLAGS") {
        sendResponse(await explainFlags(String((msg as any).sessionId || "")));
      } else if (msg?.type === "GET_HEALTH") {
        sendResponse({ ok: true, health: await healthReport() });
      } else {
        sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (err: any) {
      console.error("[LectureAI][bg] message handler error:", err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true; // async sendResponse
});

// ── Keyboard shortcut ────────────────────────────────────────────────────────
// The panel has its own Alt+L handler, but during a lecture the focus is almost
// never in the panel — it's on the video, or nowhere. A browser-level command is
// the difference between "one tap" and "find the window, then one tap".

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== "flag-moment") return;
  const result = await flagNow();
  if (!result.ok) log("flag shortcut ignored —", result.error);
});

// ── Badge ────────────────────────────────────────────────────────────────────

function updateBadge() {
  if (session?.status === "capturing") {
    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
  } else if (session?.status === "paused") {
    chrome.action.setBadgeText({ text: "II" });
    chrome.action.setBadgeBackgroundColor({ color: "#ffd974" });
  } else if (session?.status === "starting" || session?.status === "stopping") {
    chrome.action.setBadgeText({ text: "..." });
    chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// Update badge periodically
setInterval(updateBadge, 1000);

log("service worker loaded");
