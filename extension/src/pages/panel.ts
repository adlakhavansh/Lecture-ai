import type {
  LectureSession,
  LectureInsights,
  TranscriptSegment,
  StudentFlag,
  ProfPin,
  BackgroundToPopup,
} from '../types';
import { CATCHUP_WINDOWS, ASK_STACK_LIMIT } from '../config';

// ── DOM ──────────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const pulse = $('pulse');
const timerEl = $('timer');
const btnToggle = $<HTMLButtonElement>('btn-toggle');
const nowPlaying = $('nowplaying');
const npTopic = $('np-topic');
const npBars = $('np-bars');
const btnPause = $<HTMLButtonElement>('btn-pause');
const icoPause = $('ico-pause');
const icoPlay = $('ico-play');
const pausedBar = $('paused-bar');
const selBar = $('sel-bar');

const catchupStamp = $('catchup-stamp');
const catchupBody = $('catchup-body');
const doubtsCount = $('doubts-count');
const doubtsBody = $('doubts-body');
const cardCatchup = $('card-catchup');
const cardDoubts = $('card-doubts');
const cardTerms = $('card-terms');
const btnRequestion = $<HTMLButtonElement>('btn-requestion');
const doubtsNudge = $('doubts-nudge');
const doubtsNudgeText = $('doubts-nudge-text');
const termsBody = $('terms-body');
const cardAssumed = $('card-assumed');
const assumedBody = $('assumed-body');
const askStack = $('ask-stack');
const panelError = $('panel-error');

const viewLive = $('view-live');
const viewScript = $('view-script');
const scriptBody = $('script-body');
const segCount = $('seg-count');
const btnCopy = $('btn-copy');

const composer = $<HTMLFormElement>('composer');
const askInput = $<HTMLInputElement>('ask-input');
const askSend = $<HTMLButtonElement>('ask-send');

const cardMarked = $('card-marked');
const markedCount = $('marked-count');
const pinsGroup = $('pins-group');
const pinsBody = $('pins-body');
const flagsGroup = $('flags-group');
const flagsBody = $('flags-body');
const btnFlag = $<HTMLButtonElement>('btn-flag');
const icoFlag = $('ico-flag');
const icoFlagged = $('ico-flagged');
const flagCount = $('flag-count');

// ── State ────────────────────────────────────────────────────────────────────

let session: LectureSession | null = null;
let insights: LectureInsights | null = null;
let segments: TranscriptSegment[] = [];
let flags: StudentFlag[] = [];
let pins: ProfPin[] = [];
let ticker: ReturnType<typeof setInterval> | null = null;
let stampTicker: ReturnType<typeof setInterval> | null = null;
let autoScroll = true;
let inviteTimer: ReturnType<typeof setTimeout> | null = null;
/** Original card order, so we can put things back once the moment passes. */
let doubtsPromoted = false;
/** Text the student highlighted, kept because the selection is lost the moment
 *  they click a button in the toolbar. */
let heldSelection = '';
let levelDecay: ReturnType<typeof setTimeout> | null = null;
let markedTimer: ReturnType<typeof setTimeout> | null = null;
let flagResetTimer: ReturnType<typeof setTimeout> | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-IN', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function elapsedFrom(start: number, pausedMs = 0): string {
  const s = Math.max(0, Math.floor((Date.now() - start - pausedMs) / 1000));
  const m = Math.floor(s / 60);
  return `${m.toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

/** "just now" / "40s ago" / "3m ago" — freshness is the whole promise here. */
function ago(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 8) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function notice(msg: string) {
  panelError.textContent = msg;
  panelError.classList.remove('hidden');
  setTimeout(() => panelError.classList.add('hidden'), 6000);
}

// ── Header / live state ──────────────────────────────────────────────────────

const LIVE = new Set(['capturing']);
const WORKING = new Set(['starting', 'stopping', 'transcribing', 'summarizing']);
/** Paused is neither live nor working: the session is intact, just not listening. */
const HOLDING = new Set(['paused']);

function paintHeader() {
  const status = session?.status ?? 'idle';

  pulse.className = 'pulse ' +
    (LIVE.has(status) ? 'is-live'
      : HOLDING.has(status) ? 'is-hold'
      : WORKING.has(status) ? 'is-work'
      : status === 'error' ? 'is-bad'
      : 'is-idle');

  // Pause is only meaningful mid-lecture, so the control only exists then.
  const pausable = LIVE.has(status) || HOLDING.has(status);
  btnPause.classList.toggle('hidden', !pausable);
  btnPause.title = HOLDING.has(status) ? 'Resume capture' : 'Pause capture';
  btnPause.setAttribute('aria-label', btnPause.title);
  icoPause.classList.toggle('hidden', HOLDING.has(status));
  icoPlay.classList.toggle('hidden', !HOLDING.has(status));
  pausedBar.classList.toggle('hidden', !HOLDING.has(status));
  if (!LIVE.has(status)) setLevel(0);

  if (LIVE.has(status) || HOLDING.has(status)) {
    btnToggle.textContent = 'Stop';
    btnToggle.className = 'pill is-stop';
    btnToggle.disabled = false;
  } else if (WORKING.has(status)) {
    btnToggle.textContent = status === 'starting' ? 'Starting' : 'Wrapping up';
    btnToggle.className = 'pill';
    btnToggle.disabled = true;
  } else {
    btnToggle.textContent = 'Start';
    btnToggle.className = 'pill';
    btnToggle.disabled = false;
  }

  if (session && LIVE.has(status)) {
    timerEl.textContent = elapsedFrom(session.startTime, session.pausedMs);
    startTicker();
  } else {
    stopTicker();
    if (session && HOLDING.has(status)) {
      timerEl.textContent = elapsedFrom(session.startTime, session.pausedMs);
    } else if (!session || status === 'idle') {
      timerEl.textContent = '00:00';
    }
  }

  nowPlaying.classList.toggle('is-on', LIVE.has(status) || HOLDING.has(status));
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (session && LIVE.has(session.status)) {
      timerEl.textContent = elapsedFrom(session.startTime, session.pausedMs);
    }
  }, 1000);
}

function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

// Keep the "updated Ns ago" stamp honest without re-rendering the card.
function startStampTicker() {
  if (stampTicker) return;
  stampTicker = setInterval(() => {
    if (insights?.updatedAt && insights.recap.length) {
      catchupStamp.textContent = `updated ${ago(insights.updatedAt)}`;
    }
  }, 5000);
}

// ── Now playing ──────────────────────────────────────────────────────────────

function paintNowPlaying() {
  const topic = insights?.currentTopic;
  if (topic) {
    npTopic.textContent = topic;
    nowPlaying.classList.remove('is-waiting');
  } else if (session && HOLDING.has(session.status)) {
    npTopic.textContent = 'paused';
    nowPlaying.classList.add('is-waiting');
  } else if (session && LIVE.has(session.status)) {
    npTopic.textContent = 'listening…';
    nowPlaying.classList.add('is-waiting');
  } else {
    npTopic.textContent = 'nothing yet — hit start';
    nowPlaying.classList.add('is-waiting');
  }
}

// ── Level meter ──────────────────────────────────────────────────────────────
// These four bars used to be a CSS animation that ran regardless of whether any
// sound was arriving — which made "we're listening" an assertion rather than a
// fact. They now move with the real signal off the offscreen analyser, so silent
// bars are a genuine and useful warning that the tab isn't producing audio.

function setLevel(level: number) {
  npBars.style.setProperty('--lvl', String(Math.max(0, Math.min(1, level))));
  npBars.classList.toggle('is-hot', level > 0.06);
}

/** If levels stop arriving — worker evicted, capture ended — fall back to flat
 *  rather than freezing mid-waveform and implying sound that isn't there. */
function noteLevel(level: number) {
  setLevel(level);
  if (levelDecay) clearTimeout(levelDecay);
  levelDecay = setTimeout(() => setLevel(0), 900);
}

// ── Cards ────────────────────────────────────────────────────────────────────

function paintCatchup() {
  if (!insights || insights.recap.length === 0) {
    catchupStamp.textContent = session && LIVE.has(session.status) ? 'listening…' : '—';
    return;
  }
  catchupStamp.textContent = `updated ${ago(insights.updatedAt)}`;
  catchupBody.innerHTML =
    `<ul>${insights.recap.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
  startStampTicker();
}

function paintDoubts() {
  if (!insights || insights.questions.length === 0) {
    doubtsCount.textContent = session && LIVE.has(session.status) ? 'listening…' : '—';
    return;
  }
  doubtsCount.textContent = `${insights.questions.length} ready`;
  doubtsBody.innerHTML = `<div class="qlist">${insights.questions.map((q, i) => `
    <div class="q">
      <div class="q-text">${esc(q.question)}</div>
      <div class="q-foot">
        <span class="q-basis" title="${esc(q.basis)}">from: ${esc(q.basis)}</span>
        <button class="q-copy" data-q="${i}">copy</button>
      </div>
    </div>`).join('')}</div>`;

  doubtsBody.querySelectorAll<HTMLButtonElement>('.q-copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = insights?.questions[Number(btn.dataset.q)];
      if (!q) return;
      navigator.clipboard.writeText(q.question).then(() => {
        btn.textContent = 'copied';
        setTimeout(() => (btn.textContent = 'copy'), 1600);
      });
    });
  });
}

function paintTerms() {
  if (!insights || insights.terms.length === 0) return;
  termsBody.innerHTML = `<div class="terms">${insights.terms.map((t) => `
    <div class="term-row">
      <div class="term-name">${esc(t.term)}</div>
      <div class="term-def">${esc(t.meaning)}</div>
    </div>`).join('')}</div>`;
}

function paintAssumed() {
  const rows = insights?.assumed ?? [];
  cardAssumed.classList.toggle('hidden', rows.length === 0);
  if (rows.length === 0) return;
  assumedBody.innerHTML = `<div class="terms">${rows.map((t) => `
    <div class="term-row">
      <div class="term-name">${esc(t.term)}</div>
      <div class="term-def">${esc(t.meaning)}</div>
    </div>`).join('')}</div>`;
}

function paintInsights() {
  paintNowPlaying();
  paintCatchup();
  paintDoubts();
  paintTerms();
  paintAssumed();
}

// ── "They just asked for questions" ──────────────────────────────────────────

/** The professor opening the floor is the moment this whole panel exists for.
 *  Rather than making the student notice it, hoist the doubts card above the
 *  recap, flare it once, and put everything back afterwards so the calm default
 *  layout returns on its own. */
function promoteDoubts(heard: string) {
  doubtsNudgeText.textContent = heard.startsWith('any')
    ? `They just said "${heard}"`
    : 'They just opened the floor';
  doubtsNudge.classList.remove('hidden');

  if (!doubtsPromoted) {
    viewLive.insertBefore(cardDoubts, cardCatchup);
    doubtsPromoted = true;
  }

  cardDoubts.classList.remove('is-alert');
  // Reflow so the animation restarts even on a repeat invite.
  void cardDoubts.offsetWidth;
  cardDoubts.classList.add('is-alert');

  viewLive.scrollTop = 0;

  if (inviteTimer) clearTimeout(inviteTimer);
  inviteTimer = setTimeout(demoteDoubts, 90_000);
}

function demoteDoubts() {
  if (inviteTimer) { clearTimeout(inviteTimer); inviteTimer = null; }
  doubtsNudge.classList.add('hidden');
  cardDoubts.classList.remove('is-alert');
  if (doubtsPromoted) {
    viewLive.insertBefore(cardDoubts, cardTerms);
    doubtsPromoted = false;
  }
}

// ── Refresh questions ────────────────────────────────────────────────────────

btnRequestion.addEventListener('click', async () => {
  btnRequestion.classList.add('is-busy');
  btnRequestion.disabled = true;
  const before = doubtsBody.innerHTML;
  doubtsBody.innerHTML =
    '<div class="shimmer"></div><div class="shimmer w80"></div>';

  const resp = await chrome.runtime.sendMessage({ type: 'REFRESH_QUESTIONS' });

  btnRequestion.classList.remove('is-busy');
  btnRequestion.disabled = false;

  if (resp?.ok && resp.insights?.questions?.length) {
    insights = resp.insights;
    paintDoubts();
  } else {
    doubtsBody.innerHTML = before;
    notice(resp?.error || 'No different questions in the last few minutes yet.');
  }
});

// ── Marked moments ───────────────────────────────────────────────────────────

/** Highlight the cue that fired, so a pin explains why it's a pin. Otherwise
 *  "the assignment is due on Friday" and any other sentence look alike, and the
 *  student has to trust the list instead of seeing it work. */
function markCue(text: string, cue: string): string {
  const at = text.toLowerCase().indexOf(cue.toLowerCase());
  if (at < 0) return esc(text);
  return (
    esc(text.slice(0, at)) +
    `<em>${esc(text.slice(at, at + cue.length))}</em>` +
    esc(text.slice(at + cue.length))
  );
}

function paintMarked() {
  const total = pins.length + flags.length;
  cardMarked.classList.toggle('hidden', total === 0);
  if (total === 0) {
    flagCount.classList.add('hidden');
    return;
  }

  // The button carries the flag count all lecture; the card carries the detail.
  flagCount.textContent = String(flags.length);
  flagCount.classList.toggle('hidden', flags.length === 0);

  const bits: string[] = [];
  if (pins.length) bits.push(`${pins.length} to check`);
  if (flags.length) bits.push(`${flags.length} flagged`);
  markedCount.textContent = bits.join(' · ');

  pinsGroup.classList.toggle('hidden', pins.length === 0);
  flagsGroup.classList.toggle('hidden', flags.length === 0);

  // Newest first: a deadline you just heard matters more than one from 40
  // minutes ago, which you've already dealt with.
  pinsBody.innerHTML = [...pins].reverse().map((p) => `
    <div class="mark">
      <span class="mark-t">${clockTime(p.at).slice(0, 5)}</span>
      <span class="mark-x">${markCue(p.text, p.cue)}</span>
      <span></span>
    </div>`).join('');

  flagsBody.innerHTML = [...flags].reverse().map((f) => `
    <div class="mark">
      <span class="mark-t">${clockTime(f.at).slice(0, 5)}</span>
      <span class="mark-x">${esc(f.text)}</span>
      <button class="mark-undo" data-at="${f.at}" title="Unflag" aria-label="Unflag">&times;</button>
    </div>`).join('');

  flagsBody.querySelectorAll<HTMLButtonElement>('.mark-undo').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const at = Number(btn.dataset.at);
      const flag = flags.find((f) => f.at === at);
      if (!flag) return;
      const resp = await chrome.runtime.sendMessage({
        type: 'TOGGLE_FLAG', at: flag.at, text: flag.text,
      });
      if (resp?.ok && resp.flags) { flags = resp.flags; paintMarked(); paintTranscript(); }
    });
  });
}

/** A pin arriving mid-lecture gets one flare. Anything more insistent than that
 *  and the student is now watching the panel instead of the professor, which is
 *  the exact failure this product is supposed to prevent. */
function flarePins() {
  cardMarked.classList.remove('is-alert');
  void cardMarked.offsetWidth;
  cardMarked.classList.add('is-alert');
  if (markedTimer) clearTimeout(markedTimer);
  markedTimer = setTimeout(() => cardMarked.classList.remove('is-alert'), 4_000);
}

/** One tap, no typing, no dialog. The whole value of this depends on it being
 *  cheaper than the thought "I'll look that up later". */
async function flagThisMoment() {
  if (!session || !LIVE.has(session.status)) {
    notice('Start a lecture first — flags mark a moment in the audio.');
    return;
  }
  btnFlag.disabled = true;
  const resp = await chrome.runtime.sendMessage({ type: 'FLAG_NOW' });
  btnFlag.disabled = false;

  if (!resp?.ok) { notice(resp?.error || 'Could not mark that moment.'); return; }
  if (resp.flag) flags = [...flags.filter((f) => f.id !== resp.flag.id), resp.flag];
  paintMarked();

  // Tick for a beat, then back to the flag — a permanently ticked button would
  // stop reading as "tap me again".
  btnFlag.classList.add('is-done');
  icoFlag.classList.add('hidden');
  icoFlagged.classList.remove('hidden');
  if (flagResetTimer) clearTimeout(flagResetTimer);
  flagResetTimer = setTimeout(() => {
    btnFlag.classList.remove('is-done');
    icoFlag.classList.remove('hidden');
    icoFlagged.classList.add('hidden');
  }, 1_400);
}

btnFlag.addEventListener('click', flagThisMoment);

/** Alt+L works anywhere in the panel, and a matching browser-level shortcut is
 *  registered in the manifest for when the panel doesn't have focus — which,
 *  during a lecture, is most of the time. */
document.addEventListener('keydown', (e) => {
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    flagThisMoment();
  }
});

// ── Transcript view ──────────────────────────────────────────────────────────

function paintTranscript() {
  segCount.textContent = `${segments.length} line${segments.length === 1 ? '' : 's'}`
    + (flags.length ? ` · ${flags.length} flagged` : '');
  if (segments.length === 0) {
    scriptBody.innerHTML = '<p class="empty">Nothing captured yet.</p>';
    return;
  }
  const flagged = new Set(flags.map((f) => `${f.at}|${f.text}`));
  scriptBody.innerHTML = segments.map((s) => `
    <div class="line${flagged.has(`${s.startTime}|${s.text}`) ? ' is-flagged' : ''}"
         data-t="${s.startTime}" role="button" tabindex="0"
         title="Jump the video to ${clockTime(s.startTime)}">
      <span class="line-t">${clockTime(s.startTime)}</span>
      <span class="line-x">${esc(s.text)}</span>
      <button class="line-flag" tabindex="-1"
              title="Flag this line as unclear" aria-label="Flag this line as unclear">
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path d="M4.2 2.4h7.6v11.2L8 10.7l-3.8 2.9z" fill="none"
                stroke="currentColor" stroke-width="1.7"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>`).join('');

  if (autoScroll && !viewScript.classList.contains('hidden')) {
    viewScript.scrollTop = viewScript.scrollHeight;
  }
}

viewScript.addEventListener('scroll', () => {
  const nearBottom =
    viewScript.scrollTop + viewScript.clientHeight >= viewScript.scrollHeight - 60;
  autoScroll = nearBottom;
});

// ── Tabs ─────────────────────────────────────────────────────────────────────

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.remove('is-on');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('is-on');
    tab.setAttribute('aria-selected', 'true');
    const live = tab.dataset.tab === 'live';
    viewLive.classList.toggle('hidden', !live);
    viewScript.classList.toggle('hidden', live);
    if (!live) { autoScroll = true; paintTranscript(); }
  });
});

// ── Start / stop ─────────────────────────────────────────────────────────────

btnToggle.addEventListener('click', async () => {
  const live = session && LIVE.has(session.status);
  btnToggle.disabled = true;

  if (live) {
    await chrome.runtime.sendMessage({ type: 'STOP_LECTURE' });
  } else {
    const resp = await chrome.runtime.sendMessage({ type: 'START_LECTURE' });
    if (!resp?.ok && resp?.error) notice(resp.error);
  }
  btnToggle.disabled = false;
  await refreshStatus();
});

// ── Rewind chips ─────────────────────────────────────────────────────────────

document.querySelectorAll<HTMLButtonElement>('.chip').forEach((chip) => {
  chip.addEventListener('click', async () => {
    const mins = Number(chip.dataset.window);
    if (!CATCHUP_WINDOWS.includes(mins as (typeof CATCHUP_WINDOWS)[number])) return;

    const label = chip.textContent;
    chip.classList.add('is-busy');
    chip.textContent = '…';
    catchupBody.innerHTML =
      '<div class="shimmer"></div><div class="shimmer w80"></div><div class="shimmer w60"></div>';

    const resp = await chrome.runtime.sendMessage({ type: 'CATCH_ME_UP', windowMinutes: mins });
    chip.classList.remove('is-busy');
    chip.textContent = label;

    if (resp?.ok && resp.insights) {
      insights = resp.insights;
      paintInsights();
    } else {
      catchupBody.innerHTML = `<p class="empty">${esc(resp?.error || 'Could not build a recap just now.')}</p>`;
    }
  });
});

// ── Ask ──────────────────────────────────────────────────────────────────────

function addAnswerCard(question: string): { fill: (a: string) => void; fail: (e: string) => void } {
  const card = document.createElement('div');
  card.className = 'answer';
  card.innerHTML = `
    <div class="answer-q">
      <span class="eyebrow">you asked</span>
      <span>${esc(question)}</span>
      <button class="answer-close" aria-label="Dismiss">&times;</button>
    </div>
    <div class="answer-a">
      <div class="shimmer"></div><div class="shimmer w80"></div>
    </div>`;
  card.querySelector('.answer-close')!.addEventListener('click', () => card.remove());
  askStack.prepend(card);

  while (askStack.children.length > ASK_STACK_LIMIT) {
    askStack.lastElementChild?.remove();
  }

  const body = card.querySelector<HTMLElement>('.answer-a')!;
  return {
    fill: (a: string) => { body.textContent = a; },
    fail: (e: string) => { body.innerHTML = `<p class="empty">${esc(e)}</p>`; },
  };
}

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = askInput.value.trim();
  if (!q) return;

  askInput.value = '';
  askSend.disabled = true;
  const slot = addAnswerCard(q);

  const resp = await chrome.runtime.sendMessage({ type: 'ASK_QUESTION', question: q });
  askSend.disabled = false;

  if (resp?.ok && resp.answer) slot.fill(resp.answer);
  else slot.fail(resp?.error || 'No answer came back. Check the server is running.');
});

// ── Copy transcript ──────────────────────────────────────────────────────────

btnCopy.addEventListener('click', () => {
  if (segments.length === 0) return;
  const text = segments.map((s) => `[${clockTime(s.startTime)}] ${s.text}`).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    btnCopy.textContent = 'Copied';
    setTimeout(() => (btnCopy.textContent = 'Copy all'), 1800);
  });
});

// ── Jump the video to a line ─────────────────────────────────────────────────
// A transcript is only half useful if you can't get back to the moment. The
// timestamp is wall-clock, so the background does the arithmetic against where
// the video was when capture started.

async function seekToLine(startTime: number, row: HTMLElement) {
  row.classList.add('is-seeking');
  const resp = await chrome.runtime.sendMessage({ type: 'SEEK_TO', startTime });
  row.classList.remove('is-seeking');
  if (!resp?.ok) notice(resp?.error || 'Could not jump to that moment.');
}

scriptBody.addEventListener('click', (e) => {
  // The per-line flag button lives inside the row, so it has to claim the click
  // before the row's seek handler treats it as "jump the video here".
  const fl = (e.target as HTMLElement).closest<HTMLElement>('.line-flag');
  if (fl) {
    e.stopPropagation();
    const row = fl.closest<HTMLElement>('.line');
    const at = Number(row?.dataset.t);
    const text = row?.querySelector('.line-x')?.textContent || '';
    if (at && text) toggleLineFlag(at, text);
    return;
  }
  // Ignore clicks that were really a text selection — those mean "explain this".
  if ((window.getSelection()?.toString() || '').trim().length > 2) return;
  const row = (e.target as HTMLElement).closest<HTMLElement>('.line');
  if (row?.dataset.t) seekToLine(Number(row.dataset.t), row);
});

async function toggleLineFlag(at: number, text: string) {
  const resp = await chrome.runtime.sendMessage({ type: 'TOGGLE_FLAG', at, text });
  if (!resp?.ok) { notice(resp?.error || 'Could not flag that line.'); return; }
  if (resp.flags) { flags = resp.flags; paintMarked(); paintTranscript(); }
}

scriptBody.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = (e.target as HTMLElement).closest<HTMLElement>('.line');
  if (row?.dataset.t) { e.preventDefault(); seekToLine(Number(row.dataset.t), row); }
});

// ── Highlight to explain ─────────────────────────────────────────────────────
// The line you didn't follow is right there on screen; making you retype it into
// the ask box is the kind of small tax that stops people using a feature at all.

const EXPLAINABLE = ['#script-body', '.recap', '.answer-a', '.term-def', '.q-text'];

function selectionIsExplainable(sel: Selection): boolean {
  const node = sel.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement;
  return !!el && EXPLAINABLE.some((s) => el.closest(s));
}

function hideSelBar() {
  selBar.classList.add('hidden');
  heldSelection = '';
}

document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  const text = (sel?.toString() || '').trim();

  // Short selections are usually accidental drags, not a request.
  if (!sel || text.length < 12 || !selectionIsExplainable(sel)) {
    if (!selBar.matches(':hover')) hideSelBar();
    return;
  }

  heldSelection = text.slice(0, 1200);
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  selBar.classList.remove('hidden');
  // Sit just above the selection, clamped inside the rail.
  const w = selBar.offsetWidth || 190;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - 8);
  const top = rect.top < 56 ? rect.bottom + 8 : rect.top - selBar.offsetHeight - 8;
  selBar.style.left = `${left}px`;
  selBar.style.top = `${Math.max(8, top)}px`;
});

selBar.querySelectorAll<HTMLButtonElement>('.sel-btn').forEach((btn) => {
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  btn.addEventListener('click', async () => {
    const text = heldSelection;
    const mode = btn.dataset.mode === 'deeper' ? 'deeper' : 'simpler';
    if (!text) return;
    hideSelBar();

    // Switch to Live so the answer isn't rendered behind the transcript view.
    document.querySelector<HTMLButtonElement>('.tab[data-tab="live"]')?.click();
    const short = text.length > 90 ? `${text.slice(0, 90)}…` : text;
    const slot = addAnswerCard(`${mode === 'deeper' ? 'Deeper' : 'Simpler'}: "${short}"`);

    const resp = await chrome.runtime.sendMessage({ type: 'EXPLAIN_SELECTION', text, mode });
    if (resp?.ok && resp.answer) slot.fill(resp.answer);
    else slot.fail(resp?.error || 'Could not explain that just now.');
  });
});

document.addEventListener('scroll', hideSelBar, true);

// ── Pause / resume ───────────────────────────────────────────────────────────

async function togglePause() {
  const paused = session && HOLDING.has(session.status);
  btnPause.disabled = true;
  const resp = await chrome.runtime.sendMessage({
    type: paused ? 'RESUME_LECTURE' : 'PAUSE_LECTURE',
  });
  btnPause.disabled = false;
  if (!resp?.ok && resp?.error) notice(resp.error);
  await refreshStatus();
}

btnPause.addEventListener('click', togglePause);
$('btn-resume-inline').addEventListener('click', togglePause);

// ── Settings / history ───────────────────────────────────────────────────────

$('btn-settings').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/settings.html') });
});

$('btn-history').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/history.html') });
});

// ── Live updates from background ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: BackgroundToPopup) => {
  if (msg.type === 'STATUS_UPDATE') {
    session = msg.session;
    if (msg.session?.segments) { segments = msg.session.segments; paintTranscript(); }
    if (msg.session?.insights) { insights = msg.session.insights; paintInsights(); }
    flags = msg.session?.flags ?? [];
    pins = msg.session?.pins ?? [];
    paintMarked();
    paintHeader();
    paintNowPlaying();
  }
  if (msg.type === 'TRANSCRIPT_UPDATE') {
    segments = msg.segments;
    paintTranscript();
  }
  if (msg.type === 'INSIGHTS_UPDATE') {
    insights = msg.insights;
    paintInsights();
  }
  if (msg.type === 'AUDIO_LEVEL') noteLevel(msg.level);
  if (msg.type === 'QUESTIONS_INVITED') promoteDoubts(msg.heard);
  if (msg.type === 'PIN_ADDED') {
    if (!pins.some((p) => p.id === msg.pin.id)) pins = [...pins, msg.pin];
    paintMarked();
    flarePins();
  }
  if (msg.type === 'FLAGS_UPDATE') {
    flags = msg.flags;
    paintMarked();
    paintTranscript();
  }
  if (msg.type === 'ERROR') notice(msg.message);
});

// ── Init ─────────────────────────────────────────────────────────────────────

async function refreshStatus() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  session = resp?.session ?? null;
  if (session?.segments) segments = session.segments;
  flags = session?.flags ?? [];
  pins = session?.pins ?? [];
  paintHeader();
  paintMarked();
  paintTranscript();
}

(async () => {
  await refreshStatus();
  const ins = await chrome.runtime.sendMessage({ type: 'GET_INSIGHTS' });
  if (ins?.insights) insights = ins.insights;
  paintInsights();
})();
