// ── Direct API calls (BYOK) ──────────────────────────────────────────────────
// When the user has pasted their own keys into the options page we talk to
// Deepgram and Gemini straight from the service worker. That removes "clone the
// repo, then also run a local Express server" from the setup path — the single
// biggest barrier between someone new and a working extension.
//
// The local proxy still works and is still the fallback; nothing here replaces
// it, it just makes it optional.

import type { Settings } from "./settings";
import { languageDirective } from "./settings";

const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ── Deepgram ────────────────────────────────────────────────────────────────

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Keyword boosting. `term:2` weights a term up without hard-forcing it, which
 *  is what you want for names and jargon: "Dijkstra" stops becoming "extra". */
function keywordParams(keywords: string[]): string {
  return keywords
    .slice(0, 100)
    .map((k) => `&keywords=${encodeURIComponent(`${k}:2`)}`)
    .join("");
}

export async function transcribeDirect(
  base64: string,
  mimeType: string,
  settings: Settings
): Promise<{ text: string; confidence?: number }> {
  const url =
    `${DEEPGRAM_URL}?model=nova-2&language=en&detect_language=true&smart_format=true&paragraphs=false` +
    keywordParams(settings.keywords);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${settings.deepgramKey.trim()}`,
      "Content-Type": mimeType || "audio/webm",
    },
    body: base64ToBytes(base64) as unknown as BodyInit,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Deepgram ${resp.status}: ${detail.slice(0, 200)}`);
  }

  const data = await resp.json();
  const alt = data?.results?.channels?.[0]?.alternatives?.[0];
  return { text: alt?.transcript || "", confidence: alt?.confidence };
}

// ── Gemini ──────────────────────────────────────────────────────────────────

export interface GeminiCall {
  system: string;
  user: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Ask the model for JSON. Cheap insurance against prose wrapping. */
  json?: boolean;
}

export async function geminiDirect(call: GeminiCall, settings: Settings): Promise<string> {
  const model = settings.geminiModel.trim() || "gemini-3.6-flash";
  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(
    settings.geminiKey.trim()
  )}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: call.system + languageDirective(settings.outputLanguage) }],
      },
      contents: [{ role: "user", parts: [{ text: call.user }] }],
      generationConfig: {
        temperature: call.temperature ?? 0.2,
        maxOutputTokens: call.maxOutputTokens ?? 900,
        ...(call.json ? { responseMimeType: "application/json" } : {}),
      },
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Gemini ${resp.status}: ${detail.slice(0, 200)}`);
  }

  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p: { text?: string }) => p?.text || "").join("")
    : "";
  if (!text.trim()) {
    const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason;
    throw new Error(`Gemini returned nothing${reason ? ` (${reason})` : ""}`);
  }
  return text;
}

/** Model output arrives as JSON text; be forgiving about fences and stray prose. */
export function parseJsonLoose(raw: string): any {
  let text = (raw || "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}
