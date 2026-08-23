// Shared configuration constants for Lecture AI

// ── Backend ──────────────────────────────────────────────────────────────────
/** Base URL of the local backend proxy that holds API keys. */
export const BACKEND_URL = "http://localhost:3001";

// ── Audio Pipeline ───────────────────────────────────────────────────────────
/** Interval (ms) between VAD energy samples. */
export const VAD_SAMPLE_MS = 250;

/** Milliseconds of silence before flushing an audio chunk for transcription. */
export const SILENCE_FLUSH_MS = 750;

/** Maximum buffered audio duration (ms) before force-flushing. */
export const MAX_BUFFER_MS = 10000;

/** Maximum audio chunks pending send before pausing the recorder. */
export const MAX_PENDING_CHUNKS = 20;

/** Number of completed audio chunks that may transcribe at the same time. */
export const TRANSCRIPTION_CONCURRENCY = 2;

/** Timeout (ms) for draining pending chunks before dropping them. */
export const DRAIN_TIMEOUT_MS = 30000;

/** Minimum bytes for an audio chunk to be worth transcribing. */
export const MIN_CHUNK_BYTES = 5000;

// ── Summarization ────────────────────────────────────────────────────────────
/** Maximum tokens for the summary response. Kept in sync with the server's
 *  maxOutputTokens — the actual model call happens server-side (see
 *  server/index.ts), this is just documentation for the extension side. */
export const SUMMARY_MAX_TOKENS = 1200;

// ── Live insights ────────────────────────────────────────────────────────────
/** How often the rolling insight call runs while capturing.
 *  chrome.alarms enforces a 1-minute floor for periodInMinutes, so this is
 *  driven by a self-rescheduling one-shot alarm instead. */
export const INSIGHT_INTERVAL_MS = 75_000;

/** How far back the rolling insight call looks. Keeps "catch me up" about the
 *  stretch you just missed rather than the whole lecture. */
export const INSIGHT_WINDOW_MS = 5 * 60_000;

/** Don't burn a model call until there's at least this much new speech. */
export const INSIGHT_MIN_NEW_CHARS = 220;

/** Delay before the FIRST insight run. The steady cadence is 75s, but waiting
 *  that long from a cold start means the panel sits empty through exactly the
 *  moment someone is deciding whether this thing works. 30s is the floor
 *  chrome.alarms will actually honour; the character-driven trigger below is
 *  what usually beats it to the punch. */
export const FIRST_INSIGHT_DELAY_MS = 30_000;

/** Enough speech to be worth a first call, lower than the steady-state bar. */
export const FIRST_INSIGHT_MIN_CHARS = 90;

/** Rewind windows offered on the catch-me-up card (minutes). */
export const CATCHUP_WINDOWS = [3, 7, 15] as const;

/** Transcript context sent with an ad-hoc question. */
export const ASK_CONTEXT_CHARS = 12_000;

/** Max ask answers kept on screen at once. */
export const ASK_STACK_LIMIT = 3;

/** Questions already shown, sent back so a refresh gives genuinely new ones
 *  instead of rephrasing the same thought. */
export const QUESTION_EXCLUDE_LIMIT = 8;

/** Phrases that mean the professor just opened the floor. Cheap string match on
 *  incoming transcript — no model call — because this is the one moment the
 *  whole product exists for and the student shouldn't have to notice it first.
 *  Kept lowercase; matched against lowercased transcript text. */
export const QUESTION_INVITE_CUES = [
  "any questions",
  "any question",
  "any doubts",
  "any doubt",
  "questions so far",
  "doubts so far",
  "anything unclear",
  "is that clear",
  "is this clear",
  "does that make sense",
  "does this make sense",
  "everyone following",
  "are you following",
  "anyone want to ask",
  "want to ask something",
  "shall i move on",
  "should i move on",
  "can we move on",
  "before we move on",
] as const;

/** Ignore repeat invite cues fired inside this window, so one "any questions,
 *  any doubts?" doesn't alert twice. */
export const INVITE_COOLDOWN_MS = 45_000;

// ── Marked moments ───────────────────────────────────────────────────────────

/** Phrases that mean the professor is talking about assessment, not content.
 *
 *  These are matched with a plain `includes()` — no model call — for the same
 *  reason as the invite cues: a deadline mentioned in passing is the single
 *  most expensive thing to miss, and it cannot wait 75 seconds for the next
 *  insight cycle.
 *
 *  Precision matters more than recall here. The obvious cues — "test",
 *  "project", "assignment", "problem", "marks" — are deliberately absent as
 *  bare words, because in a normal CS lecture they are ordinary content
 *  vocabulary ("we test the hypothesis", "the project of formalising this",
 *  "assignment operator", "marks the boundary"). A pin list that fires on
 *  every window is worse than no pin list: the student stops reading it. So
 *  the multi-word forms carry those nouns instead, and only nouns that have no
 *  innocent reading stand alone. */
export const PROF_PIN_CUES = [
  // Assessment nouns with no other meaning in a lecture.
  "quiz",
  "midterm",
  "mid-term",
  "endterm",
  "end-term",
  "viva",
  "weightage",
  "syllabus",
  // Exam, but only where it's being scheduled or scoped.
  "in the exam",
  "for the exam",
  "on the exam",
  "exam will",
  "exams will",
  "exam is",
  "asked in the exam",
  "comes in the exam",
  // Deadlines.
  "due date",
  "is due",
  "due by",
  "due on",
  "last date",
  "deadline",
  "submission date",
  "submit by",
  "submit it by",
  "hand it in",
  // Weighting and marking.
  "will be graded",
  "carries marks",
  "carry marks",
  "worth marks",
  "of your grade",
  "of the total marks",
  "negative marking",
  // Explicit instruction to record something.
  "note this down",
  "write this down",
  "make a note of this",
  "this is important for",
  "remember this for",
  "important for the",
  // Graded work being handed out.
  "assignment is",
  "assignment will",
  "the assignment",
  "problem set",
  "lab report",
  "project proposal",
  "project submission",
  "graded assignment",
] as const;

/** Ignore further pins inside this window. A professor spelling out an exam
 *  policy will trip four cues in one breath; that's one moment, not four. */
export const PIN_COOLDOWN_MS = 40_000;

/** Cap per lecture. Past this the list stops being a list of things to check. */
export const PIN_LIMIT = 24;

/** How far back "I'm lost" reaches. Confusion is noticed a beat late — you
 *  realise you stopped following somewhere behind where the voice now is — so
 *  the flag captures the run-up, not the instant of the tap. */
export const FLAG_WINDOW_MS = 45_000;

/** Cap per lecture, generous: flagging is the student's own judgement and the
 *  limit exists only to keep storage and the summary page sane. */
export const FLAG_LIMIT = 40;

/** Two flags inside this window describe the same stretch of audio, so the
 *  second is folded into the first. Covers both a jumpy double-tap and Alt+L
 *  arriving twice because a page handled it as well as the browser. */
export const FLAG_DEDUPE_MS = 4_000;

/** Flags re-explained after the lecture ends. Each one is its own model call,
 *  so this is the line between thorough and rude. Anything past this keeps its
 *  timestamp and text and simply has no explanation attached. */
export const FLAG_EXPLAIN_LIMIT = 8;

/** Words of transcript context handed to the re-explanation call, so it can
 *  answer "what did he mean" rather than paraphrasing the flagged line. */
export const FLAG_EXPLAIN_CONTEXT_CHARS = 1_800;


// ── Service Worker ───────────────────────────────────────────────────────────
/** Minimum ms between state broadcast messages to popup/tabs. */
export const BROADCAST_THROTTLE_MS = 500;

/** Max retries for API calls with exponential back-off. */
export const MAX_RETRIES = 5;

/** Base delay (ms) for retry back-off. */
export const RETRY_BASE_MS = 1000;

/** Attempts per audio chunk before it's dropped. A failed chunk used to vanish
 *  silently, leaving a hole in the transcript that nothing ever filled. */
export const CHUNK_MAX_ATTEMPTS = 3;

/** Back-off between chunk retries. Short — the lecture is still moving. */
export const CHUNK_RETRY_BASE_MS = 1200;

/** How often the offscreen document reports input level to the panel. */
export const LEVEL_REPORT_MS = 120;

/** Lectures kept in the history index. */
export const HISTORY_LIMIT = 50;

/** Keep-alive ping interval (ms) to prevent SW suspension during a lecture. */
export const KEEPALIVE_INTERVAL_MS = 20_000;

// ── Debug ────────────────────────────────────────────────────────────────────
export const DEBUG = import.meta.env?.DEV === true;
