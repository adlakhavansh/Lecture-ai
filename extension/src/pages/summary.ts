import type {
  BackgroundToPopup,
  LectureSession,
  SummaryDoc,
  StudentFlag,
  ProfPin,
} from '../types';

const summaryContent = document.getElementById('summary-content')!;
const summaryMeta = document.getElementById('summary-meta')!;
const titleEl = document.getElementById('summary-title')!;
const loadingEl = document.getElementById('loading')!;
const errorSection = document.getElementById('error-section')!;
const errorText = document.getElementById('error-text')!;
const btnRetry = document.getElementById('btn-retry')!;
const btnCopy = document.getElementById('btn-copy')!;
const btnTranscript = document.getElementById('btn-transcript')!;

let sessionId = new URLSearchParams(location.search).get('sid') || '';
let plainText = '';

function esc(text: string): string {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ── Rendering ────────────────────────────────────────────────────────────────
// The summary used to be one wall of markdown. A study document is read by
// jumping — "what were the formulas", "what did they say was examinable" — so
// each of those is now its own addressable section, and empty ones simply
// don't appear rather than showing a heading with nothing under it.

function bullets(items: string[]): string {
  return `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
}

function section(label: string, body: string, tone = ''): string {
  if (!body) return '';
  return `<section class="sec ${tone}"><h2>${esc(label)}</h2>${body}</section>`;
}

function renderDoc(doc: SummaryDoc): string {
  const out: string[] = [];

  if (doc.tldr) {
    out.push(`<section class="sec tldr"><h2>In short</h2><p>${esc(doc.tldr)}</p></section>`);
  }

  if (doc.keyPoints.length) {
    // The one section worth reading if you read nothing else, so it leads and
    // carries the numbering that makes it feel like a checklist.
    out.push(
      `<section class="sec keypoints"><h2>Key points</h2><ol>${doc.keyPoints
        .map((k) => `<li>${esc(k)}</li>`)
        .join('')}</ol></section>`
    );
  }

  if (doc.topics.length) {
    out.push(
      `<section class="sec"><h2>How the lecture moved</h2><div class="topics">${doc.topics
        .map(
          (t) => `<div class="topic">
            <h3>${esc(t.topic)}</h3>
            <p>${esc(t.detail)}</p>
          </div>`
        )
        .join('')}</div></section>`
    );
  }

  if (doc.emphasis.length) {
    out.push(section('The professor stressed', bullets(doc.emphasis), 'stress'));
  }

  if (doc.formulas.length) {
    out.push(
      section(
        'Formulas and rules',
        `<div class="formulas">${doc.formulas.map((f) => `<code>${esc(f)}</code>`).join('')}</div>`
      )
    );
  }

  if (doc.terms.length) {
    out.push(
      section(
        'Terms',
        `<dl class="terms">${doc.terms
          .map((t) => `<dt>${esc(t.term)}</dt><dd>${esc(t.meaning)}</dd>`)
          .join('')}</dl>`
      )
    );
  }

  if (doc.examples.length) out.push(section('Examples used', bullets(doc.examples)));
  if (doc.openQuestions.length) out.push(section('Left open', bullets(doc.openQuestions), 'open'));
  if (doc.revise.length) out.push(section('Revise this', bullets(doc.revise), 'revise'));

  return out.join('');
}

// ── Marked moments ───────────────────────────────────────────────────────────
// These lead the page, ahead of "In short", and that ordering is the whole
// point. If you already followed the lecture, the three places you flagged are
// the only part of this document you need — making you scroll past a full study
// summary to reach them would defeat the reason for flagging in the first place.

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderFlags(flags: StudentFlag[]): string {
  if (!flags.length) return '';
  const pending = flags.filter((f) => !f.explanation).length;

  const rows = flags
    .map(
      (f) => `<div class="mark">
        <div class="mark-head">
          <span class="mark-t">${clock(f.at)}</span>
          <span class="mark-src">${f.source === 'live' ? 'flagged live' : 'flagged while reading'}</span>
        </div>
        <p class="mark-said">${esc(f.text)}</p>
        ${
          f.explanation
            ? `<p class="mark-ex">${esc(f.explanation)}</p>`
            : '<p class="mark-ex is-empty">Not re-explained yet.</p>'
        }
      </div>`
    )
    .join('');

  return `<section class="sec marks flagged">
    <div class="marks-top">
      <h2>You flagged this</h2>
      ${
        pending
          ? `<button id="btn-explain-flags" class="btn-sm">Re-explain ${pending}</button>`
          : ''
      }
    </div>
    <p class="marks-lede">${flags.length} moment${flags.length === 1 ? '' : 's'} you marked as unclear, in plain language. If the rest of the lecture made sense, this is the only part you need.</p>
    <div class="mark-list">${rows}</div>
  </section>`;
}

function renderPins(pins: ProfPin[]): string {
  if (!pins.length) return '';
  const rows = pins
    .map(
      (p) => `<div class="mark">
        <div class="mark-head">
          <span class="mark-t">${clock(p.at)}</span>
          <span class="mark-src">heard "${esc(p.cue)}"</span>
        </div>
        <p class="mark-said">${esc(p.text)}</p>
      </div>`
    )
    .join('');

  return `<section class="sec marks dontmiss">
    <div class="marks-top"><h2>Don't miss</h2></div>
    <p class="marks-lede">Every time a quiz, deadline, submission or marking scheme came up — quoted exactly as it was said, not summarised.</p>
    <div class="mark-list">${rows}</div>
  </section>`;
}

/** Fallback for sessions summarized before the structured format existed. */
function renderMd(text: string): string {
  const lines = text.split('\n');
  let html = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('### ')) html += `<h3>${inlineMd(trimmed.slice(4))}</h3>`;
    else if (trimmed.startsWith('## ')) html += `<h2>${inlineMd(trimmed.slice(3))}</h2>`;
    else if (trimmed.startsWith('# ')) html += `<h2>${inlineMd(trimmed.slice(2))}</h2>`;
    else if (trimmed.startsWith('- ')) html += `<ul><li>${inlineMd(trimmed.slice(2))}</li></ul>`;
    else html += `<p>${inlineMd(trimmed)}</p>`;
  }
  return html.replace(/<\/ul>\s*<ul>/g, '');
}

function inlineMd(text: string): string {
  return esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function paintMeta(session: Partial<LectureSession>) {
  const bits: string[] = [];
  if (session.startTime) {
    bits.push(
      new Date(session.startTime).toLocaleString([], {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    );
  }
  if (session.startTime && session.endTime) {
    const mins = Math.max(1, Math.round((session.endTime - session.startTime) / 60_000));
    bits.push(`${mins} min`);
  }
  if (session.segments?.length) bits.push(`${session.segments.length} lines`);
  summaryMeta.textContent = bits.join('  ·  ');
}

function show(session: Partial<LectureSession>) {
  loadingEl.classList.add('hidden');
  errorSection.classList.add('hidden');

  // Marked moments come from the session itself, not from SummaryDoc — they're
  // the student's own record and a model call has no business regenerating them.
  const marks = renderFlags(session.flags ?? []) + renderPins(session.pins ?? []);

  if (session.summaryDoc) {
    const doc = session.summaryDoc;
    if (doc.title) titleEl.textContent = doc.title;
    summaryContent.innerHTML = marks + renderDoc(doc);
  } else if (session.summary) {
    summaryContent.innerHTML = marks + renderMd(session.summary);
  } else {
    summaryContent.innerHTML = marks;
  }

  document.getElementById('btn-explain-flags')?.addEventListener('click', explainFlags);

  plainText = summaryContent.innerText;
  paintMeta(session);
}

/** Each flag becomes its own model call, so this is opt-in and shows progress.
 *  Firing it automatically at stop would also miss the flags added afterwards,
 *  while reading the transcript — which is when most flagging happens. */
async function explainFlags() {
  const btn = document.getElementById('btn-explain-flags') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  const resp = await chrome.runtime.sendMessage({ type: 'EXPLAIN_FLAGS', sessionId });
  if (!resp?.ok && resp?.error) {
    if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
    return;
  }
  await load();
}

function showError(msg: string) {
  loadingEl.classList.add('hidden');
  errorSection.classList.remove('hidden');
  errorText.textContent = msg;
}

chrome.runtime.onMessage.addListener((msg: BackgroundToPopup) => {
  // A retry finishing elsewhere should update this tab, so re-read the session
  // rather than trusting the flat string the broadcast carries.
  if (msg.type === 'SUMMARY_UPDATE') load();
  if (msg.type === 'ERROR') showError(msg.message);
});

btnCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(plainText || summaryContent.innerText).then(() => {
    btnCopy.textContent = 'Copied';
    setTimeout(() => (btnCopy.textContent = 'Copy'), 1800);
  });
});

btnTranscript.addEventListener('click', () => {
  if (sessionId) location.href = `transcript.html?sid=${encodeURIComponent(sessionId)}`;
});

btnRetry.addEventListener('click', async () => {
  loadingEl.classList.remove('hidden');
  errorSection.classList.add('hidden');
  const resp = await chrome.runtime.sendMessage({ type: 'RETRY_SUMMARY', sessionId });
  if (!resp?.ok && resp?.error) showError(resp.error);
  else load();
});

async function load() {
  if (!sessionId) {
    showError('No lecture specified.');
    return;
  }
  const resp = await chrome.runtime.sendMessage({ type: 'GET_SESSION', sessionId });
  const session = resp?.session as LectureSession | undefined;
  if (!session) {
    showError('That lecture is no longer stored.');
    return;
  }
  if (session.summaryDoc || session.summary) show(session);
  else if (session.status === 'summarizing') loadingEl.classList.remove('hidden');
  else {
    // No summary, but flags and pins are still worth showing — they were never
    // model output, so a failed summary shouldn't take them down with it.
    if (session.flags?.length || session.pins?.length) show(session);
    else paintMeta(session);
    showError('No summary for this lecture yet.');
    loadingEl.classList.add('hidden');
    errorSection.classList.remove('hidden');
  }
}

load();
