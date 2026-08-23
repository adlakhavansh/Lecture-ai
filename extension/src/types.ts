// ── Transcript ─────────────────────────────────────────────────────────────

/** A single timestamped transcript segment produced by the STT service. */
export interface TranscriptSegment {
  id: string;
  startTime: number;   // epoch ms when this segment started
  endTime: number;     // epoch ms when this segment ended
  text: string;
  confidence?: number;
}

// ── Live insights ────────────────────────────────────────────────────────────

/** A question the student could ask the professor, grounded in a real line. */
export interface SuggestedQuestion {
  /** The question, phrased as the student would say it out loud. */
  question: string;
  /** Short quote from the transcript this question came from. Keeps it honest. */
  basis: string;
}

export interface GlossaryTerm {
  term: string;
  meaning: string;
}

/** Something the lecture leans on without re-explaining. Distinct from a new
 *  term: this is knowledge being taken for granted, which is exactly what makes
 *  a student quietly lose the thread. */
export type AssumedKnowledge = GlossaryTerm;

// ── Live insights ────────────────────────────────────────────────────────────

/**
 * One object powering every card in the side panel. Produced by a single
 * periodic model call so adding a card is prompt work, not plumbing.
 */
export interface LectureInsights {
  /** epoch ms this object was produced */
  updatedAt: number;
  /** what's being covered right now, short noun phrase */
  currentTopic: string | null;
  /** 2-4 bullets covering the recent window — the "catch me up" body */
  recap: string[];
  /** questions worth asking when the professor invites doubts */
  questions: SuggestedQuestion[];
  /** technical terms introduced recently */
  terms: GlossaryTerm[];
  /** prior knowledge this stretch assumes you already have */
  assumed: AssumedKnowledge[];
  /** topics seen so far this lecture, most recent last */
  coveredTopics: string[];
}

// ── Marked moments ───────────────────────────────────────────────────────────
// Two kinds of pin, and the difference between them is who decided. A student
// flag is an act of self-knowledge — "I stopped following here" — which is the
// one judgement a model cannot make on someone's behalf. A professor pin is a
// cheap string match on assessment language, which is the one thing too
// expensive to miss. Neither is the model guessing at importance.

/** A moment the student marked as unclear, live or after the fact. */
export interface StudentFlag {
  id: string;
  /** Wall-clock ms of the moment flagged. */
  at: number;
  /** What was being said around then — the thing that actually lost them. */
  text: string;
  /** "live" = tapped mid-lecture, "transcript" = tapped on a line afterwards. */
  source: "live" | "transcript";
  /** A plain-language re-explanation, filled in once the lecture ends. */
  explanation?: string;
}

/** Something the professor said about a quiz, exam, project or deadline.
 *  Cue-matched rather than model-inferred, so it cannot be quietly dropped. */
export interface ProfPin {
  id: string;
  at: number;
  /** The cue phrase that fired, kept so the pin can explain itself. */
  cue: string;
  /** The line it fired on. */
  text: string;
}

// ── Lecture Session ──────────────────────────────────────────────────────────

export type SessionStatus =
  | "idle"
  | "starting"
  | "capturing"
  | "paused"
  | "stopping"
  | "transcribing"
  | "summarizing"
  | "complete"
  | "error";

export interface LectureSession {
  id: string;
  tabId: number;
  tabUrl: string;
  status: SessionStatus;
  startTime: number;
  endTime?: number;
  segments: TranscriptSegment[];
  summary?: string;
  /** Structured study document produced when the lecture ends. */
  summaryDoc?: SummaryDoc;
  insights?: LectureInsights;
  errorMessage?: string;
  /** The lecture video's own playhead (seconds) when capture began, so a
   *  transcript timestamp can be mapped back to a position in the video. */
  videoStartAt?: number;
  /** Total time spent paused, so elapsed time stays honest across breaks. */
  pausedMs?: number;
  /** Moments the student marked as unclear. Optional so sessions saved before
   *  flagging existed still load. */
  flags?: StudentFlag[];
  /** Assessment and deadline mentions caught by cue matching. */
  pins?: ProfPin[];
}

// ── Structured summary ───────────────────────────────────────────────────────

export interface SummaryTopic {
  topic: string;
  detail: string;
}

/** The post-lecture document. Sectioned rather than one prose blob, because a
 *  student revising wants to jump to key points, not read an essay. */
export interface SummaryDoc {
  generatedAt: number;
  title: string;
  tldr: string;
  keyPoints: string[];
  topics: SummaryTopic[];
  terms: GlossaryTerm[];
  formulas: string[];
  examples: string[];
  /** Things the professor explicitly flagged as important or examinable. */
  emphasis: string[];
  openQuestions: string[];
  revise: string[];
}

// ── History ──────────────────────────────────────────────────────────────────

/** Index row for a past lecture. The full session stays under session_<id>. */
export interface HistoryEntry {
  id: string;
  title: string;
  tabUrl: string;
  startTime: number;
  endTime: number;
  segmentCount: number;
  hasSummary: boolean;
  topics: string[];
  /** So the history list can show "3 flagged" without loading the transcript. */
  flagCount?: number;
  pinCount?: number;
}

// ── Messages (extension internal) ────────────────────────────────────────────

/** Messages from popup / pages → background service worker */
export type PopupToBackground =
  | { type: "START_LECTURE" }
  | { type: "STOP_LECTURE" }
  | { type: "GET_STATUS" }
  | { type: "GET_SESSION"; sessionId: string }
  | { type: "GET_TRANSCRIPT" }
  | { type: "GET_INSIGHTS" }
  | { type: "CATCH_ME_UP"; windowMinutes: number }
  | { type: "ASK_QUESTION"; question: string }
  | { type: "REFRESH_QUESTIONS" }
  | { type: "PAUSE_LECTURE" }
  | { type: "RESUME_LECTURE" }
  | { type: "EXPLAIN_SELECTION"; text: string; mode: "simpler" | "deeper" }
  | { type: "SEEK_TO"; startTime: number }
  | { type: "GET_HISTORY" }
  | { type: "DELETE_HISTORY_ENTRY"; sessionId: string }
  | { type: "GENERATE_SUMMARY" }
  | { type: "RETRY_SUMMARY"; sessionId: string }
  /** One-tap "I'm lost" — pins the moment plus the last stretch of speech. */
  | { type: "FLAG_NOW" }
  /** Flag or unflag a specific line, live or in a past lecture. */
  | { type: "TOGGLE_FLAG"; sessionId?: string; at: number; text: string }
  /** Fill in the plain-language re-explanation for any flag missing one. */
  | { type: "EXPLAIN_FLAGS"; sessionId: string }
  /** Keys, queue depth and last failure — what the popup's health dot reads. */
  | { type: "GET_HEALTH" };

/** What the popup's health dot is built from. Deliberately three facts and no
 *  score: "keys missing" and "falling behind" need different reactions, and a
 *  single green/red light would flatten them into the same shrug. */
export interface HealthReport {
  /** Where model and STT calls are going, or nothing if neither is configured. */
  mode: "direct" | "proxy" | "none";
  /** Audio chunks waiting to be transcribed. */
  queued: number;
  /** Chunks mid-flight right now. */
  active: number;
  /** Last transcription failure, if one happened this session. */
  lastError?: string;
}

/** Messages from background → popup / pages */
export type BackgroundToPopup =
  | { type: "STATUS_UPDATE"; session: LectureSession | null }
  | { type: "TRANSCRIPT_UPDATE"; segments: TranscriptSegment[] }
  | { type: "INSIGHTS_UPDATE"; insights: LectureInsights }
  | { type: "SUMMARY_UPDATE"; summary: string }
  /** The professor just invited questions — surface the doubts card, loudly. */
  | { type: "QUESTIONS_INVITED"; heard: string }
  /** Live input level, 0..1. Drives the equaliser so "it's listening" is a
   *  fact on screen rather than a decorative animation. */
  | { type: "AUDIO_LEVEL"; level: number }
  /** A cue-matched assessment mention. Sent the instant it's heard rather than
   *  waiting for the next insight cycle — a due date you learn 75 seconds late
   *  is a due date you might have already talked over. */
  | { type: "PIN_ADDED"; pin: ProfPin }
  /** Flag list changed, so every surface showing a count can stay honest. */
  | { type: "FLAGS_UPDATE"; flags: StudentFlag[] }
  | { type: "ERROR"; message: string };

/** Messages from offscreen → background */
export type OffscreenToBackground =
  | { type: "OFFSCREEN_READY" }
  | { type: "OFFSCREEN_LEVEL"; level: number }
  | { type: "OFFSCREEN_AUDIO_CHUNK"; audioBase64: string; mimeType: string }
  | { type: "OFFSCREEN_CAPTURE_STOPPED" }
  | { type: "OFFSCREEN_LOG"; message: string }
  | { type: "OFFSCREEN_ERROR"; error: string };

/** Messages from background → offscreen */
export type BackgroundToOffscreen =
  | { type: "OFFSCREEN_PING" }
  | { type: "OFFSCREEN_PAUSE" }
  | { type: "OFFSCREEN_RESUME" }
  | { type: "OFFSCREEN_START_CAPTURE"; streamId: string; tabId: number }
  | { type: "OFFSCREEN_STOP_CAPTURE" };

// ── Backend API ──────────────────────────────────────────────────────────────

export interface TranscribeResponse {
  text: string;
  confidence?: number;
}

export interface SummarizeResponse {
  /** Kept for the older plain-text path and for copy/export. */
  summary: string;
  doc?: SummaryDoc;
}

export interface InsightsResponse {
  currentTopic: string | null;
  recap: string[];
  questions: SuggestedQuestion[];
  terms: GlossaryTerm[];
  assumed?: AssumedKnowledge[];
}

export interface AskResponse {
  answer: string;
}
