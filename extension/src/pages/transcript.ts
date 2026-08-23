import type {
  TranscriptSegment,
  LectureSession,
  StudentFlag,
  ProfPin,
  BackgroundToPopup,
} from '../types';

const transcriptEl = document.getElementById('transcript')!;
const emptyEl = document.getElementById('empty')!;
const segmentCountEl = document.getElementById('segment-count')!;
const flagCountEl = document.getElementById('flag-count')!;
const btnCopy = document.getElementById('btn-copy')!;
const btnSummary = document.getElementById('btn-summary')!;
const pageTitle = document.getElementById('page-title')!;
const metaEl = document.getElementById('meta')!;

let sessionId = new URLSearchParams(location.search).get('sid') || '';
let segments: TranscriptSegment[] = [];
let flags: StudentFlag[] = [];
let pins: ProfPin[] = [];
let autoScroll = true;

function fmt(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** A flag identifies a moment by time + words, not by segment id, because the
 *  same flag has to survive being written from the panel, the popup shortcut and
 *  this page — three surfaces that don't share segment objects. */
function key(at: number, text: string): string {
  return `${at}|${text}`;
}

function renderSegments(newSegments: TranscriptSegment[]) {
  const existingIds = new Set(segments.map(s => s.id));
  const added = newSegments.filter(s => !existingIds.has(s.id));
  segments = newSegments;

  for (const seg of added) {
    const div = document.createElement('div');
    div.className = 'segment';
    div.dataset.at = String(seg.startTime);
    div.innerHTML = `
      <span class="segment-time">${fmt(seg.startTime)}</span>
      <span class="segment-text">${escapeHtml(seg.text)}</span>
      <button class="segment-flag" type="button"
              title="Flag this line as unclear" aria-label="Flag this line as unclear">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M4.2 2.4h7.6v11.2L8 10.7l-3.8 2.9z" fill="none"
                stroke="currentColor" stroke-width="1.7"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    `;
    transcriptEl.appendChild(div);
  }

  segmentCountEl.textContent = `${segments.length} segment${segments.length !== 1 ? 's' : ''}`;
  emptyEl.classList.toggle('hidden', segments.length > 0);
  applyMarks();

  if (autoScroll && added.length > 0) {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }
}

/** Applied as a separate pass over the rendered rows rather than folded into
 *  rendering, because segments arrive incrementally and flags change out of
 *  band — rebuilding an hour of transcript on every toggle would be visible. */
function applyMarks() {
  const flagged = new Set(flags.map(f => key(f.at, f.text)));
  const pinned = new Set(pins.map(p => key(p.at, p.text)));

  transcriptEl.querySelectorAll<HTMLElement>('.segment').forEach((row, i) => {
    const seg = segments[i];
    if (!seg) return;
    const k = key(seg.startTime, seg.text);
    row.classList.toggle('is-flagged', flagged.has(k));
    row.classList.toggle('is-pinned', pinned.has(k));
  });

  flagCountEl.textContent = `${flags.length} flagged`;
  flagCountEl.classList.toggle('hidden', flags.length === 0);
}

async function toggleFlag(at: number, text: string) {
  const resp = await chrome.runtime.sendMessage({ type: 'TOGGLE_FLAG', sessionId, at, text });
  if (resp?.ok && resp.flags) { flags = resp.flags; applyMarks(); }
}

/** Delegated, so rows appended later during a live lecture work without
 *  re-binding anything. */
transcriptEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.segment-flag');
  if (!btn) return;
  const row = btn.closest<HTMLElement>('.segment');
  const at = Number(row?.dataset.at);
  const text = row?.querySelector('.segment-text')?.textContent || '';
  if (at && text) toggleFlag(at, text);
});

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Detect manual scroll to disable auto-scroll
let scrollTimeout: ReturnType<typeof setTimeout>;
window.addEventListener('scroll', () => {
  autoScroll = false;
  clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 100;
    if (nearBottom) autoScroll = true;
  }, 1500);
});

// Listen for updates from background
chrome.runtime.onMessage.addListener((msg: BackgroundToPopup) => {
  if (msg.type === 'TRANSCRIPT_UPDATE') renderSegments(msg.segments);
  if (msg.type === 'STATUS_UPDATE' && msg.session) renderSegments(msg.session.segments);
  if (msg.type === 'FLAGS_UPDATE') { flags = msg.flags; applyMarks(); }
  if (msg.type === 'PIN_ADDED') {
    if (!pins.some(p => p.id === msg.pin.id)) pins = [...pins, msg.pin];
    applyMarks();
  }
});

// Copy all
btnCopy.addEventListener('click', () => {
  const text = segments.map(s => `[${fmt(s.startTime)}] ${s.text}`).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    btnCopy.textContent = 'Copied!';
    setTimeout(() => btnCopy.textContent = 'Copy All', 2000);
  });
});

btnSummary.addEventListener('click', () => {
  location.href = `summary.html?sid=${encodeURIComponent(sessionId)}`;
});

/** A past lecture and a running one want different headings and different
 *  behaviour — auto-scrolling an hour-old transcript to the bottom is wrong. */
function paintChrome(session: LectureSession) {
  const live = session.status === 'capturing' || session.status === 'paused';
  pageTitle.textContent = live ? 'Live transcript' : session.summaryDoc?.title || 'Transcript';
  autoScroll = live;

  if (session.summaryDoc || session.summary) btnSummary.classList.remove('hidden');

  const bits: string[] = [];
  if (session.startTime) {
    bits.push(new Date(session.startTime).toLocaleString([], {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    }));
  }
  if (session.endTime) {
    const mins = Math.max(1, Math.round((session.endTime - session.startTime) / 60_000));
    bits.push(`${mins} min`);
  }
  metaEl.textContent = live ? '' : bits.join('  ·  ');
}

// Init: load saved segments
(async () => {
  if (!sessionId) return;
  const resp = await chrome.runtime.sendMessage({ type: 'GET_SESSION', sessionId });
  if (resp?.session) {
    paintChrome(resp.session);
    flags = resp.session.flags ?? [];
    pins = resp.session.pins ?? [];
  }
  if (resp?.session?.segments) renderSegments(resp.session.segments);
  // Also request current status for live sessions
  const statusResp = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (statusResp?.session?.id === sessionId && statusResp.session.segments) {
    flags = statusResp.session.flags ?? flags;
    pins = statusResp.session.pins ?? pins;
    renderSegments(statusResp.session.segments);
  }
  applyMarks();
})();
