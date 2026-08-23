import type {
  LectureSession,
  LectureInsights,
  HealthReport,
  BackgroundToPopup,
} from './types';
import { loadSettings, canGoDirect, canTranscribeDirect } from './settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const pulse = $('pulse');
const timer = $('timer');
const stateLabel = $('state-label');
const stateSub = $('state-sub');
const btnPrimary = $<HTMLButtonElement>('btn-primary');
const btnPanel = $<HTMLButtonElement>('btn-panel');
const btnFlag = $<HTMLButtonElement>('btn-flag');
const flagLabel = $('flag-label');
const stats = $('stats');
const statLines = $('stat-lines');
const statFlags = $('stat-flags');
const statPins = $('stat-pins');
const catchup = $('catchup');
const catchupAge = $('catchup-age');
const catchupTopic = $('catchup-topic');
const catchupBody = $('catchup-body');
const catchupMore = $('catchup-more');
const healthRow = document.querySelector<HTMLElement>('.health')!;
const healthDot = $('health-dot');
const healthText = $('health-text');
const post = $('post');
const btnSummary = $<HTMLButtonElement>('btn-summary');
const btnRetry = $<HTMLButtonElement>('btn-retry');
const errorEl = $('error');
const setupNudge = $('setup-nudge');

let session: LectureSession | null = null;
let insights: LectureInsights | null = null;
let health: HealthReport | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let flagResetTimer: ReturnType<typeof setTimeout> | null = null;
/** null until checkSetup() has an answer — "unknown" and "down" want different
 *  copy, and guessing wrong makes a working setup look broken. */
let proxyUp: boolean | null = null;
/** Resolved at popup load so the click handler never has to await a query
 *  before calling sidePanel.open() — awaiting first can spend the user
 *  gesture Chrome requires, and the panel then silently refuses to open. */
let activeTabId: number | null = null;

const LIVE = new Set(['capturing']);
const WORKING = new Set(['starting', 'stopping', 'transcribing', 'summarizing']);
const HOLDING = new Set(['paused']);

/** Written from the student's side of the screen: what's true, what to do. */
const COPY: Record<string, { label: string; sub: string }> = {
  idle:        { label: 'Ready when you are',  sub: 'Open your lecture tab, then start.' },
  starting:    { label: 'Tuning in…',          sub: 'Grabbing audio from this tab.' },
  capturing:   { label: 'Listening',           sub: 'The live panel is keeping up for you.' },
  paused:      { label: 'Paused',               sub: 'Resume from the live panel when you\'re back.' },
  stopping:    { label: 'Wrapping up',         sub: 'Finishing the last few lines.' },
  transcribing:{ label: 'Writing your summary', sub: 'One moment.' },
  summarizing: { label: 'Writing your summary', sub: 'One moment.' },
  complete:    { label: 'That’s a wrap',   sub: 'Your transcript and summary are saved.' },
  error:       { label: 'Something broke',      sub: 'Check your API keys, or that the proxy is running.' },
};

function show(el: HTMLElement) { el.classList.remove('hidden'); }
function hide(el: HTMLElement) { el.classList.add('hidden'); }

function elapsed(start: number, pausedMs = 0): string {
  const s = Math.max(0, Math.floor((Date.now() - start - pausedMs) / 1000));
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

function showError(msg: string) {
  errorEl.textContent = msg;
  show(errorEl);
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (session && LIVE.has(session.status)) {
      timer.textContent = elapsed(session.startTime, session.pausedMs);
    }
    paintCatchupAge();
  }, 1000);
}

function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

function paint() {
  const status = session?.status ?? 'idle';
  const copy = COPY[status] ?? COPY.idle;

  stateLabel.textContent = copy.label;
  stateSub.textContent = copy.sub;

  pulse.className = 'pulse ' +
    (LIVE.has(status) ? 'is-live'
      : HOLDING.has(status) ? 'is-hold'
      : WORKING.has(status) ? 'is-work'
      : status === 'error' ? 'is-bad'
      : 'is-idle');

  // Primary action
  if (LIVE.has(status) || HOLDING.has(status)) {
    btnPrimary.textContent = 'Stop listening';
    btnPrimary.className = 'big is-stop';
    btnPrimary.disabled = false;
    show(timer);
    timer.textContent = elapsed(session!.startTime, session!.pausedMs);
    if (LIVE.has(status)) startTicker(); else stopTicker();
  } else if (WORKING.has(status)) {
    btnPrimary.textContent = copy.label;
    btnPrimary.className = 'big';
    btnPrimary.disabled = true;
    stopTicker();
  } else {
    btnPrimary.textContent = 'Start listening';
    btnPrimary.className = 'big';
    btnPrimary.disabled = false;
    hide(timer);
    stopTicker();
  }

  // Flagging only means something while there's audio to point at.
  if (LIVE.has(status)) show(btnFlag); else hide(btnFlag);

  // Counts only mean something once there's a session
  const lines = session?.segments?.length ?? 0;
  const flags = session?.flags?.length ?? 0;
  const pinCount = session?.pins?.length ?? 0;

  if (lines > 0 || LIVE.has(status) || HOLDING.has(status)) {
    show(stats);
    statLines.textContent = String(lines);
    statFlags.textContent = String(flags);
    statPins.textContent = String(pinCount);
    statFlags.className = 'stat-n' + (flags ? ' is-flag' : '');
    statPins.className = 'stat-n' + (pinCount ? ' is-pin' : '');
  } else {
    hide(stats);
  }

  paintCatchup();

  // Post-lecture
  if (status === 'complete' && session) {
    show(post);
    if (session.summary || session.summaryDoc) { show(btnSummary); hide(btnRetry); }
    else if (lines > 0) { hide(btnSummary); show(btnRetry); }
    else { hide(btnSummary); hide(btnRetry); }
  } else {
    hide(post);
  }
}

// ── Mini catch-me-up ─────────────────────────────────────────────────────────
// Two bullets and the current topic. Not a smaller panel — the panel exists and
// is one click away. This is for the case where you tab away, come back, and
// want to know what you missed without committing to reading anything.

const POPUP_RECAP_LINES = 2;

function paintCatchupAge() {
  if (!insights?.updatedAt) { catchupAge.textContent = ''; return; }
  const mins = Math.floor((Date.now() - insights.updatedAt) / 60_000);
  catchupAge.textContent = mins < 1 ? 'just now' : `${mins} min ago`;
}

function paintCatchup() {
  const live = LIVE.has(session?.status ?? '') || HOLDING.has(session?.status ?? '');
  const recap = insights?.recap ?? [];

  // A recap from a finished lecture is stale by definition — that's what the
  // summary is for — so this card belongs to the live states only.
  if (!live || (!recap.length && !insights?.currentTopic)) {
    hide(catchup);
    return;
  }
  show(catchup);

  if (insights?.currentTopic) {
    catchupTopic.textContent = insights.currentTopic;
    show(catchupTopic);
  } else {
    hide(catchupTopic);
  }

  catchupBody.innerHTML = '';
  for (const line of recap.slice(0, POPUP_RECAP_LINES)) {
    const li = document.createElement('li');
    li.textContent = line;
    catchupBody.appendChild(li);
  }

  const left = recap.length - POPUP_RECAP_LINES;
  if (left > 0) {
    catchupMore.textContent = `+${left} more in the live panel`;
    show(catchupMore);
  } else {
    hide(catchupMore);
  }

  paintCatchupAge();
}

// ── Health ───────────────────────────────────────────────────────────────────
// One dot and one sentence covering the three ways this silently breaks: no keys
// configured, the proxy not running, and chunks failing to transcribe. All three
// used to surface as an empty panel ninety seconds into a lecture.

function paintHealth() {
  if (!health) return;
  const pending = health.queued + health.active;
  let tone = '';
  let text = '';
  let detail = '';

  if (health.lastError) {
    tone = 'is-bad';
    text = 'A clip failed to transcribe — retrying.';
    detail = health.lastError;
  } else if (pending > 2) {
    tone = 'is-busy';
    text = `Catching up — ${pending} clips still to transcribe.`;
  } else if (health.mode === 'none') {
    text = 'No keys yet — add them under Keys & setup.';
  } else if (health.mode === 'direct') {
    tone = 'is-ok';
    text = 'Your keys, straight to the APIs.';
  } else if (proxyUp === false) {
    tone = 'is-busy';
    text = 'Local server isn\'t answering yet.';
  } else {
    tone = 'is-ok';
    text = 'Running through your local server.';
  }

  healthDot.className = 'hdot ' + tone;
  healthRow.className = 'health ' + (tone === 'is-bad' ? 'is-bad' : '');
  healthText.textContent = text;
  // The raw failure is useful but far too long for a 268px column, so it lives
  // on hover instead of wrapping across four lines.
  healthRow.title = detail;
}

async function refreshHealth() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_HEALTH' });
  if (resp?.health) { health = resp.health; paintHealth(); }
}

// ── Actions ──────────────────────────────────────────────────────────────────

/** Opening the panel must happen inside the click handler — Chrome requires a
 *  live user gesture, and awaiting anything first spends it. `activeTabId` and
 *  setOptions are both resolved at load time so this call is the first thing
 *  the handler does. */
function openPanel(): Promise<void> {
  if (activeTabId == null) return Promise.resolve();
  return chrome.sidePanel.open({ tabId: activeTabId }).catch((err) => {
    console.warn('[LectureAI][popup] side panel open failed:', err);
  });
}

btnPrimary.addEventListener('click', async () => {
  hide(errorEl);
  const live = session && LIVE.has(session.status);
  btnPrimary.disabled = true;

  if (live) {
    await chrome.runtime.sendMessage({ type: 'STOP_LECTURE' });
    stopTicker();
  } else {
    // Open the panel first, while the gesture is still fresh.
    openPanel();
    const resp = await chrome.runtime.sendMessage({ type: 'START_LECTURE' });
    if (!resp?.ok) {
      btnPrimary.disabled = false;
      if (resp?.error) showError(resp.error);
      return;
    }
  }
  await refresh();
  btnPrimary.disabled = false;
});

/** Deliberately does not close the popup: the confirmation is the point. You
 *  tapped it because you're lost, and you need to see that it registered. */
async function flagMoment() {
  const resp = await chrome.runtime.sendMessage({ type: 'FLAG_NOW' });
  if (!resp?.ok) {
    if (resp?.error) showError(resp.error);
    return;
  }
  btnFlag.classList.add('is-done');
  flagLabel.textContent = 'Marked — you\'ll get this re-explained';
  if (flagResetTimer) clearTimeout(flagResetTimer);
  flagResetTimer = setTimeout(() => {
    btnFlag.classList.remove('is-done');
    flagLabel.textContent = 'Lost me here';
  }, 1600);
  await refresh();
}

btnFlag.addEventListener('click', flagMoment);

// The browser-level Alt+L works everywhere, including here — but Chrome only
// delivers it to commands when no page has swallowed it, so the popup handles
// its own. Background dedupes anything landing twice within a few seconds.
document.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 'l' || e.key === 'L') && session && LIVE.has(session.status)) {
    e.preventDefault();
    flagMoment();
  }
});

function openTab(page: string) {
  chrome.tabs.create({ url: chrome.runtime.getURL(page) });
  window.close();
}

$('btn-settings').addEventListener('click', () => openTab('pages/settings.html'));
$('btn-setup').addEventListener('click', () => openTab('pages/settings.html'));
$('btn-history').addEventListener('click', () => openTab('pages/history.html'));

btnPanel.addEventListener('click', () => {
  openPanel().then(() => window.close());
});

btnSummary.addEventListener('click', () => {
  if (!session?.id) return;
  chrome.tabs.create({ url: chrome.runtime.getURL(`pages/summary.html?sid=${session.id}`) });
});

btnRetry.addEventListener('click', async () => {
  if (!session?.id) return;
  btnRetry.textContent = 'Retrying…';
  const resp = await chrome.runtime.sendMessage({ type: 'RETRY_SUMMARY', sessionId: session.id });
  btnRetry.textContent = 'Summary failed — try again';
  if (!resp?.ok && resp?.error) showError(resp.error);
  else await refresh();
});

// ── Live updates ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: BackgroundToPopup) => {
  if (msg.type === 'STATUS_UPDATE') { session = msg.session; paint(); }
  if (msg.type === 'TRANSCRIPT_UPDATE') {
    statLines.textContent = String(msg.segments.length);
    if (session) session.segments = msg.segments;
    // A chunk just landed, so the queue depth and last-error both changed.
    refreshHealth();
  }
  if (msg.type === 'INSIGHTS_UPDATE') {
    insights = msg.insights;
    paintCatchup();
  }
  if (msg.type === 'FLAGS_UPDATE') {
    if (session) session.flags = msg.flags;
    statFlags.textContent = String(msg.flags.length);
    statFlags.className = 'stat-n' + (msg.flags.length ? ' is-flag' : '');
  }
  if (msg.type === 'PIN_ADDED') {
    if (session) {
      session.pins = [...(session.pins ?? []), msg.pin];
      statPins.textContent = String(session.pins.length);
      statPins.className = 'stat-n is-pin';
    }
  }
  if (msg.type === 'ERROR') { showError(msg.message); refreshHealth(); }
});

// ── Init ─────────────────────────────────────────────────────────────────────

async function refresh() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  session = resp?.session ?? null;
  const ins = await chrome.runtime.sendMessage({ type: 'GET_INSIGHTS' });
  insights = ins?.insights ?? null;
  paint();
}

/** Register the panel for this tab up front, so the click handler only has to
 *  call open(). */
async function primePanel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    activeTabId = tab.id;
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: 'pages/panel.html',
      enabled: true,
    });
  } catch (err) {
    console.warn('[LectureAI][popup] side panel prime failed:', err);
  }
}

/** Say something useful before the first failure rather than after it: with no
 *  keys and no proxy running, "Start listening" produces a confusing mid-lecture
 *  fetch error instead of an obvious setup step. */
async function checkSetup() {
  const s = await loadSettings();
  if (canGoDirect(s) && canTranscribeDirect(s)) return;
  try {
    const resp = await fetch(`${s.backendUrl}/api/health`, { signal: AbortSignal.timeout(1200) });
    if (resp.ok) { proxyUp = true; paintHealth(); return; } // proxy up, keys live server-side
  } catch {
    /* not running */
  }
  proxyUp = false;
  paintHealth();
  show(setupNudge);
}

primePanel();
refresh();
checkSetup();
refreshHealth();
// The popup is only open while someone is looking at it, so polling here is
// cheap and the dot never shows a stale queue depth.
setInterval(refreshHealth, 2500);
