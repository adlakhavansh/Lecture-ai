import {
  loadSettings,
  saveSettings,
  parseKeywords,
  canGoDirect,
  canTranscribeDirect,
  OUTPUT_LANGUAGES,
  DEFAULT_SETTINGS,
  type Settings,
} from "../settings";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

const elDeepgram = $<HTMLInputElement>("deepgram-key");
const elGemini = $<HTMLInputElement>("gemini-key");
const elModel = $<HTMLInputElement>("gemini-model");
const elKeywords = $<HTMLTextAreaElement>("keywords");
const elLanguage = $<HTMLSelectElement>("language");
const elBackend = $<HTMLInputElement>("backend-url");
const elDirect = $<HTMLInputElement>("prefer-direct");
const kwPreview = $("kw-preview");
const savedTag = $("saved");
const testOut = $("test-out");
const btnTest = $<HTMLButtonElement>("btn-test");
const routeTranscribe = $("route-transcribe");
const routeModel = $("route-model");

for (const lang of OUTPUT_LANGUAGES) {
  const opt = document.createElement("option");
  opt.value = lang;
  opt.textContent = lang;
  elLanguage.appendChild(opt);
}

// ── Reveal toggles ──────────────────────────────────────────────────────────
// A pasted key you can't read back is impossible to verify against the console
// tab you copied it from, which is where most "wrong key" confusion comes from.

for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-reveal]")) {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.reveal!) as HTMLInputElement;
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? "Show" : "Hide";
  });
}

// ── Live preview of what actually gets sent ─────────────────────────────────

function paintKeywords() {
  const terms = parseKeywords(elKeywords.value);
  kwPreview.innerHTML = "";
  for (const t of terms.slice(0, 24)) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = t;
    kwPreview.appendChild(chip);
  }
  if (terms.length > 24) {
    const more = document.createElement("span");
    more.className = "chip more";
    more.textContent = `+${terms.length - 24} more`;
    kwPreview.appendChild(more);
  }
}

/** Tells the user, in advance, which path each call will take. Otherwise "did my
 *  key actually get used?" is unanswerable without opening devtools. */
function paintRoutes() {
  const s = current();
  const t = canTranscribeDirect(s);
  const m = canGoDirect(s);
  routeTranscribe.textContent = t ? "Transcription → Deepgram direct" : "Transcription → proxy";
  routeTranscribe.className = `route ${t ? "direct" : "proxy"}`;
  routeModel.textContent = m ? "Insights → Gemini direct" : "Insights → proxy";
  routeModel.className = `route ${m ? "direct" : "proxy"}`;
}

function current(): Settings {
  return {
    deepgramKey: elDeepgram.value.trim(),
    geminiKey: elGemini.value.trim(),
    geminiModel: elModel.value.trim() || DEFAULT_SETTINGS.geminiModel,
    keywords: parseKeywords(elKeywords.value),
    outputLanguage: elLanguage.value,
    preferDirect: elDirect.checked,
    backendUrl: elBackend.value.trim() || DEFAULT_SETTINGS.backendUrl,
  };
}

function fill(s: Settings) {
  elDeepgram.value = s.deepgramKey;
  elGemini.value = s.geminiKey;
  elModel.value = s.geminiModel;
  elKeywords.value = s.keywords.join(", ");
  elLanguage.value = s.outputLanguage;
  elBackend.value = s.backendUrl;
  elDirect.checked = s.preferDirect;
  paintKeywords();
  paintRoutes();
}

let savedTimer: ReturnType<typeof setTimeout> | null = null;

function flashSaved() {
  savedTag.classList.remove("hidden");
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedTag.classList.add("hidden"), 1600);
}

async function persist() {
  await saveSettings(current());
  paintRoutes();
  flashSaved();
}

// Autosave on change — a setup page that loses a pasted key because you closed
// the tab without hitting Save is worse than no setup page.
for (const el of [elDeepgram, elGemini, elModel, elKeywords, elBackend]) {
  el.addEventListener("change", persist);
}
elKeywords.addEventListener("input", paintKeywords);
elDeepgram.addEventListener("input", paintRoutes);
elGemini.addEventListener("input", paintRoutes);
elLanguage.addEventListener("change", persist);
elDirect.addEventListener("change", persist);

$("btn-save").addEventListener("click", persist);

$("btn-clear").addEventListener("click", async () => {
  elDeepgram.value = "";
  elGemini.value = "";
  await persist();
  testOut.textContent = "Keys cleared.";
  testOut.className = "test-out";
});

// ── Key test ────────────────────────────────────────────────────────────────
// Cheapest possible real call against each service, so a typo surfaces here
// rather than mid-lecture.

btnTest.addEventListener("click", async () => {
  const s = current();
  await saveSettings(s);
  btnTest.disabled = true;
  testOut.className = "test-out";
  testOut.textContent = "Checking…";

  const results: string[] = [];
  let bad = false;

  if (s.deepgramKey) {
    try {
      const r = await fetch("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${s.deepgramKey}` },
      });
      if (r.ok) results.push("Deepgram ✓");
      else {
        results.push(`Deepgram ✗ (${r.status})`);
        bad = true;
      }
    } catch {
      results.push("Deepgram ✗ (network)");
      bad = true;
    }
  } else {
    results.push("Deepgram — no key");
  }

  if (s.geminiKey) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          s.geminiModel
        )}?key=${encodeURIComponent(s.geminiKey)}`
      );
      if (r.ok) results.push("Gemini ✓");
      else {
        // A 404 here means the key works but the model name doesn't, which is a
        // different problem and worth saying out loud.
        results.push(r.status === 404 ? `Gemini ✗ — model "${s.geminiModel}" not found` : `Gemini ✗ (${r.status})`);
        bad = true;
      }
    } catch {
      results.push("Gemini ✗ (network)");
      bad = true;
    }
  } else {
    results.push("Gemini — no key");
  }

  testOut.textContent = results.join("   ·   ");
  testOut.className = `test-out ${bad ? "bad" : "ok"}`;
  btnTest.disabled = false;
});

(async () => {
  fill(await loadSettings());
})();
