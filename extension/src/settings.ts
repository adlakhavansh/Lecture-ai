// ── User settings ────────────────────────────────────────────────────────────
// Stored in chrome.storage.local so the service worker, the side panel and the
// options page all read one source of truth. Keys live here rather than in a
// .env file so the extension runs with no local server at all — see apiDirect.ts

import { BACKEND_URL } from "./config";

export interface Settings {
  /** Deepgram key. Present ⇒ transcription can skip the proxy entirely. */
  deepgramKey: string;
  /** Gemini key. Present ⇒ every model call can skip the proxy. */
  geminiKey: string;
  geminiModel: string;
  /** Course-specific terms, boosted so Deepgram stops mangling them.
   *  "Dijkstra", "amortized", "eigenvector" — the words a general model has
   *  never heard in your accent. Biggest accuracy win per character typed. */
  keywords: string[];
  /** Language the assistant writes in. The lecture's own language is detected
   *  separately, so a Hinglish lecture can produce Hindi or English output. */
  outputLanguage: string;
  /** Use the keys above directly instead of the local proxy, when available. */
  preferDirect: boolean;
  /** Where the optional proxy lives, for anyone who prefers keys server-side. */
  backendUrl: string;
}

export const SETTINGS_KEY = "lecture_ai_settings";

export const OUTPUT_LANGUAGES = [
  "English",
  "Hindi",
  "Hinglish",
  "Bengali",
  "Marathi",
  "Tamil",
  "Telugu",
  "Kannada",
  "Gujarati",
  "Spanish",
  "French",
  "German",
] as const;

export const DEFAULT_SETTINGS: Settings = {
  deepgramKey: "",
  geminiKey: "",
  geminiModel: "gemini-3.6-flash",
  keywords: [],
  outputLanguage: "English",
  preferDirect: true,
  backendUrl: BACKEND_URL,
};

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const raw = (stored[SETTINGS_KEY] || {}) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      // Guard against a half-written older shape.
      keywords: Array.isArray(raw.keywords) ? raw.keywords : [],
      backendUrl: raw.backendUrl?.trim() || DEFAULT_SETTINGS.backendUrl,
      geminiModel: raw.geminiModel?.trim() || DEFAULT_SETTINGS.geminiModel,
      outputLanguage: raw.outputLanguage?.trim() || DEFAULT_SETTINGS.outputLanguage,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Can we talk to the model APIs without the local proxy running? */
export function canGoDirect(s: Settings): boolean {
  return s.preferDirect && !!s.geminiKey.trim();
}

export function canTranscribeDirect(s: Settings): boolean {
  return s.preferDirect && !!s.deepgramKey.trim();
}

/** Free-text field → clean term list. Accepts commas or newlines. */
export function parseKeywords(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter((k) => k.length > 1 && k.length < 40)
    .slice(0, 100);
}

/** Appended to every system prompt so one setting steers all output. */
export function languageDirective(lang: string): string {
  if (!lang || lang === "English") return "";
  if (lang === "Hinglish") {
    return "\n\nWrite your output in Hinglish — conversational Hindi-English mixing, in Latin script, the way Indian students actually speak. Keep technical terms in English.";
  }
  return `\n\nWrite ALL of your output in ${lang}, regardless of the language the professor is speaking. Keep established technical terms in English where a translation would be unclear, but everything else must be in ${lang}.`;
}
