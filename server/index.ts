import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@deepgram/sdk'; // <-- UPDATED FOR v3
import { GoogleGenAI } from '@google/genai';

const app = express();
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin.startsWith('chrome-extension://')) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin not allowed'));
  },
}));
app.use(express.json({ limit: '50mb' }));

// ── Clients ──────────────────────────────────────────────────────────────────

// <-- UPDATED FOR v3
const deepgram = createClient(process.env.DEEPGRAM_API_KEY!);

// Native Gemini client (Google's official Gen AI SDK — no OpenAI dependency).
const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// Flash is the free-tier-friendly model — plenty for lecture summarization.
// Overridable via env so a model rename never means a code edit mid-lecture.
const SUMMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
// Live cards run on the same model — they're small, frequent calls.
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || SUMMARY_MODEL;

if (!process.env.DEEPGRAM_API_KEY) console.warn('WARNING: DEEPGRAM_API_KEY not set');
if (!process.env.GEMINI_API_KEY) console.warn('WARNING: GEMINI_API_KEY not set');

/** The extension sends the student's chosen output language on every request, so
 *  one setting steers every endpoint. Mirrors settings.ts in the extension. */
function languageDirective(lang: unknown): string {
  const l = typeof lang === 'string' ? lang.trim() : '';
  if (!l || l === 'English') return '';
  if (l === 'Hinglish') {
    return '\n\nWrite your output in Hinglish — conversational Hindi-English mixing, in Latin script, the way Indian students actually speak. Keep technical terms in English.';
  }
  return `\n\nWrite ALL of your output in ${l}, regardless of the language the professor is speaking. Keep established technical terms in English where a translation would be unclear, but everything else must be in ${l}.`;
}

// ── Transcription endpoint ───────────────────────────────────────────────────

app.post('/api/transcribe', async (req, res) => {
  try {
    const { audio, keywords } = req.body;
    if (!audio || typeof audio !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid audio field' });
    }

    const buffer = Buffer.from(audio, 'base64');
    if (buffer.length < 5000) {
      return res.status(400).json({ error: 'Audio too short to transcribe' });
    }

    // Course vocabulary from the extension's settings page. `term:2` weights a
    // term up without forcing it, which is what fixes the specific failure that
    // makes lecture transcripts unusable: proper nouns and jargon getting
    // rewritten into common words ("Dijkstra" → "extra").
    const boosted = Array.isArray(keywords)
      ? keywords
          .map((k: unknown) => (typeof k === 'string' ? k.trim() : ''))
          .filter((k: string) => k.length > 1 && k.length < 40)
          .slice(0, 100)
          .map((k: string) => `${k}:2`)
      : [];

    // <-- UPDATED FOR v3: using listen.prerecorded.transcribeFile and passing the buffer directly
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      buffer,
      {
        model: 'nova-2',
        language: 'en',          // primary English, Deepgram auto-detects Hindi/Hinglish
        detect_language: true,   // enable multilingual detection
        smart_format: true,      // better punctuation
        paragraphs: false,
        ...(boosted.length ? { keywords: boosted } : {}),
      }
    );

    if (error) {
       throw new Error(`Deepgram API error: ${error.message || String(error)}`);
    }

    const text = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    const confidence = result?.results?.channels?.[0]?.alternatives?.[0]?.confidence;

    res.json({ text, confidence });
  } catch (err: any) {
    console.error('[transcribe] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Summarization endpoint (via native Gemini SDK) ──────────────────────────

// Structured summary. The extension asks for this shape and renders each section
// separately; the markdown prompt below is kept for direct/legacy callers.
// Mirrors SUMMARY_SYSTEM_PROMPT in extension/src/prompts.ts — change both.
const SUMMARY_JSON_PROMPT = `You are an academic lecture summarization assistant. You receive a timestamped transcript of a college lecture and produce a structured study document.

The professor may switch between English, Hindi, and Hinglish. Understand the meaning across language switches.

Return ONLY a JSON object with exactly these keys:

{
  "title": "short descriptive lecture title, max 8 words",
  "tldr": "2-3 sentences on what this lecture was about and what it established",
  "keyPoints": ["the 4-8 things a student must walk away knowing"],
  "topics": [{ "topic": "section name", "detail": "what was actually taught here, 2-4 sentences" }],
  "terms": [{ "term": "...", "meaning": "..." }],
  "formulas": ["any formula, rule or algorithm stated, with what each part means"],
  "examples": ["worked examples or illustrations the professor used"],
  "emphasis": ["things the professor explicitly flagged as important, examinable, or commonly misunderstood"],
  "openQuestions": ["things left unresolved, promised for later, or worth asking about"],
  "revise": ["concrete revision actions, most important first"]
}

Rules:
- keyPoints are claims and conclusions, not topic labels. "Amortized cost of dynamic array append is O(1)" not "Amortized analysis".
- topics follow the actual order the lecture moved in.
- emphasis MUST be grounded in the professor actually signalling it ("this will be on the exam", "remember this", "students always get this wrong"). Empty array if they never did.
- Prioritize what was taught. Cut filler, greetings, classroom management, repetition, transcription artifacts.
- Never invent information. Do not add textbook knowledge because it seems relevant. If the transcript is unclear, leave it out rather than fabricating.
- Any section with nothing real to say must be an empty array. An empty section is correct and expected; a padded one is a failure.

Output raw JSON only. No markdown fences, no commentary.`;

const SUMMARY_SYSTEM_PROMPT = `You are an academic lecture summarization assistant.

Given a timestamped transcript of a college lecture, produce a concise and accurate summary of what the professor taught.

The professor may switch between English, Hindi, and Hinglish. Understand the meaning across language switches and produce coherent English output.

Prioritize information actually taught by the professor.

Preserve:
- Technical definitions
- Important concepts
- Reasoning and explanations
- Examples
- Formulas
- Distinctions and comparisons
- Cause/effect relationships
- Professor emphasis
- Conclusions

Remove:
- Filler speech (um, uh, like, basically, you know)
- Repetition
- Greetings and classroom management
- Irrelevant conversation
- Transcription artifacts

Do NOT invent information not present in the lecture.
Do NOT add textbook knowledge simply because it seems relevant.
If the transcript is unclear, do not confidently fabricate the missing information.

Use this format (omit empty sections):

## Overview
2-4 sentences.

## Key Concepts
- Concept 1 — explanation
- Concept 2 — explanation

## Important Explanations
Short paragraphs for ideas the professor spent significant time on.

## Examples
- Example 1
- Example 2

## Key Takeaway
A short paragraph with the most important thing to remember.

The summary should be 300-800 words depending on content. Adapt to the lecture — if it was short, keep the summary short. If the professor spent time on one idea, give it more space. Reflect the actual lecture rather than blindly following the template.`;

app.post('/api/summarize', async (req, res) => {
  try {
    const { transcript, structured, language } = req.body;
    if (!transcript || typeof transcript !== 'string') {
      return res.status(400).json({ error: 'Missing transcript' });
    }

    // Truncate if extremely long (keep last portion which is most recent/complete)
    const maxChars = 30_000;
    const input = transcript.length > maxChars
      ? '...[earlier portion truncated]...\n' + transcript.slice(-maxChars)
      : transcript;

    const wantsDoc = structured !== false;

    const response = await gemini.models.generateContent({
      model: SUMMARY_MODEL,
      contents: input,
      config: {
        systemInstruction:
          (wantsDoc ? SUMMARY_JSON_PROMPT : SUMMARY_SYSTEM_PROMPT) + languageDirective(language),
        temperature: 0.15,
        maxOutputTokens: wantsDoc ? 2400 : 1200,
        ...(wantsDoc ? { responseMimeType: 'application/json' } : {}),
      },
    });

    const raw = response.text?.trim() || '';

    if (!wantsDoc) {
      return res.json({ summary: raw });
    }

    const parsed = parseJsonLoose(raw);
    if (!parsed) {
      // Fall back to handing back the prose rather than failing the request —
      // a slightly unstructured summary beats no summary after a whole lecture.
      return res.json({ summary: raw });
    }

    const list = (v: unknown, max: number, chars = 300) =>
      Array.isArray(v) ? v.map((x) => asString(x, chars)).filter(Boolean).slice(0, max) : [];

    res.json({
      doc: {
        generatedAt: Date.now(),
        title: asString(parsed.title, 90),
        tldr: asString(parsed.tldr, 700),
        keyPoints: list(parsed.keyPoints, 10),
        topics: Array.isArray(parsed.topics)
          ? parsed.topics
              .map((t: any) => ({ topic: asString(t?.topic, 90), detail: asString(t?.detail, 900) }))
              .filter((t: any) => t.topic && t.detail)
              .slice(0, 12)
          : [],
        terms: Array.isArray(parsed.terms)
          ? parsed.terms
              .map((t: any) => ({ term: asString(t?.term, 70), meaning: asString(t?.meaning, 240) }))
              .filter((t: any) => t.term && t.meaning)
              .slice(0, 20)
          : [],
        formulas: list(parsed.formulas, 12),
        examples: list(parsed.examples, 10),
        emphasis: list(parsed.emphasis, 8),
        openQuestions: list(parsed.openQuestions, 8),
        revise: list(parsed.revise, 8),
      },
    });
  } catch (err: any) {
    console.error('[summarize] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Live insights endpoint ──────────────────────────────────────────────────
// One call feeds every card in the side panel. Called every ~75s while
// capturing, plus on demand when the student picks a rewind window.

const INSIGHTS_SYSTEM_PROMPT = `You help a student who is sitting in a live lecture RIGHT NOW.

You receive a timestamped transcript covering only the last few minutes. The professor may mix English, Hindi and Hinglish — understand across the switching.

Return ONLY a JSON object with exactly these keys:

{
  "currentTopic": "short noun phrase for what is being covered right now, max 6 words, or null if unclear",
  "recap": ["2 to 4 bullets covering what was actually said in this window"],
  "questions": [{ "question": "...", "basis": "..." }],
  "terms": [{ "term": "...", "meaning": "..." }],
  "assumed": [{ "term": "...", "meaning": "..." }]
}

RECAP rules:
- Write for someone who zoned out and needs to re-enter the lecture in 10 seconds.
- Each bullet is one sentence, concrete, and about content — not "the professor discussed X" but what was actually said about X.
- Only what is in the transcript. Never fill gaps with textbook knowledge.

QUESTIONS rules — this is the most important field:
- 0 to 3 questions the student could say out loud when the professor asks "any doubts?".
- Each MUST come from something specific in this transcript: an idea stated without justification, a term used but not defined, a step skipped, an edge case not addressed, or a claim worth probing.
- Phrase it the way a student actually speaks. Short. No preamble.
- "basis" MUST be a short verbatim-ish quote (under 90 chars) from the transcript that the question comes from.
- If the window has nothing question-worthy, return an empty array. Never invent a question to fill space — the student may say it out loud to a real professor.
- Never ask something the professor already answered in this window.

TERMS rules:
- 0 to 4 technical terms introduced in this window that a student might not know.
- "meaning" is one short clause, under 15 words, grounded in how the professor used it.
- Skip common words. Skip terms the professor already fully defined.

ASSUMED rules:
- 0 to 3 things this stretch of lecture silently ASSUMES the student already knows — prior concepts referenced but not re-explained ("as we saw with eigenvalues", "you know how recursion works").
- These are different from TERMS: terms are being introduced now, assumed knowledge is being taken for granted.
- "meaning" is a one-sentence refresher so the student can follow along immediately.
- Only include something the professor genuinely leaned on. Empty array is correct most of the time.

Output raw JSON only. No markdown fences, no commentary.`;

/** Model output arrives as JSON text; be forgiving about fences and stray prose. */
function parseJsonLoose(raw: string): any {
  let text = (raw || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch {}
    }
    return null;
  }
}

function asString(v: unknown, max = 400): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

app.post('/api/insights', async (req, res) => {
  try {
    const { transcript, knownTopics, excludeQuestions, language } = req.body;
    if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
      return res.status(400).json({ error: 'Missing transcript' });
    }

    const seen = Array.isArray(knownTopics) ? knownTopics.slice(-8) : [];
    const contextNote = seen.length
      ? `\n\nTopics already covered earlier in this lecture (do not repeat these as currentTopic unless the professor has genuinely returned to one): ${seen.join(', ')}`
      : '';

    // Sent when the student taps refresh on the doubts card. They've read these
    // and want alternatives, so a rephrasing of the same thought is a failure.
    const asked = Array.isArray(excludeQuestions)
      ? excludeQuestions.map((q: unknown) => asString(q, 220)).filter(Boolean).slice(-8)
      : [];
    const excludeNote = asked.length
      ? `\n\nThe student has already seen these questions and wants DIFFERENT ones. Do not repeat them or rephrase the same underlying point — find another angle in the transcript, or return an empty questions array if there genuinely isn't one:\n- ${asked.join('\n- ')}`
      : '';

    const response = await gemini.models.generateContent({
      model: LIVE_MODEL,
      contents: `Transcript of the last few minutes:\n\n${transcript}${contextNote}${excludeNote}`,
      config: {
        systemInstruction: INSIGHTS_SYSTEM_PROMPT + languageDirective(language),
        // Nudge variety when the student explicitly asked for other questions.
        temperature: asked.length ? 0.75 : 0.25,
        maxOutputTokens: 1100,
        responseMimeType: 'application/json',
      },
    });

    const parsed = parseJsonLoose(response.text || '');
    if (!parsed) {
      return res.status(502).json({ error: 'Model did not return usable JSON' });
    }

    // Normalise defensively — the panel renders this straight to the DOM.
    res.json({
      currentTopic: asString(parsed.currentTopic, 80) || null,
      recap: Array.isArray(parsed.recap)
        ? parsed.recap.map((r: unknown) => asString(r, 300)).filter(Boolean).slice(0, 4)
        : [],
      questions: Array.isArray(parsed.questions)
        ? parsed.questions
            .map((q: any) => ({
              question: asString(q?.question, 220),
              basis: asString(q?.basis, 120),
            }))
            .filter((q: any) => q.question)
            .slice(0, 3)
        : [],
      terms: Array.isArray(parsed.terms)
        ? parsed.terms
            .map((t: any) => ({
              term: asString(t?.term, 60),
              meaning: asString(t?.meaning, 160),
            }))
            .filter((t: any) => t.term && t.meaning)
            .slice(0, 4)
        : [],
      assumed: Array.isArray(parsed.assumed)
        ? parsed.assumed
            .map((t: any) => ({
              term: asString(t?.term, 60),
              meaning: asString(t?.meaning, 200),
            }))
            .filter((t: any) => t.term && t.meaning)
            .slice(0, 3)
        : [],
    });
  } catch (err: any) {
    console.error('[insights] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Ask endpoint ────────────────────────────────────────────────────────────

const ASK_SYSTEM_PROMPT = `A student in a live lecture is asking you about something the professor just said.

Answer ONLY from the transcript provided. It may mix English, Hindi and Hinglish.

- Lead with the answer in the first sentence. No preamble, no "based on the transcript".
- Two to four sentences. This is read mid-lecture, not studied later.
- If the professor's explanation was partial, answer with what was said and note plainly what they did not cover.
- If the transcript genuinely does not contain the answer, say so in one sentence and name what the professor did say nearby instead. Do not substitute textbook knowledge.
- Plain prose. No headings, no bullet points, no markdown.`;

app.post('/api/ask', async (req, res) => {
  try {
    const { question, transcript, language } = req.body;
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Missing question' });
    }
    if (!transcript || typeof transcript !== 'string') {
      return res.status(400).json({ error: 'Missing transcript' });
    }

    const response = await gemini.models.generateContent({
      model: LIVE_MODEL,
      contents: `Lecture transcript so far:\n\n${transcript}\n\n---\n\nStudent's question: ${question}`,
      config: {
        systemInstruction: ASK_SYSTEM_PROMPT + languageDirective(language),
        temperature: 0.2,
        maxOutputTokens: 400,
      },
    });

    res.json({ answer: response.text?.trim() || '' });
  } catch (err: any) {
    console.error('[ask] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Explain endpoint ────────────────────────────────────────────────────────
// Highlight-to-explain from the transcript. The passage IS the question, so it
// gets its own endpoint rather than being squeezed through /api/ask.

const EXPLAIN_SYSTEM_PROMPT = `A student highlighted a line from a live lecture transcript because they did not follow it.

You get the highlighted passage plus surrounding transcript for context.

- Explain what it means, grounded in how the professor used it.
- SIMPLER mode: plain words, one concrete everyday analogy, assume no background. Three or four sentences.
- DEEPER mode: the mechanism, why it is true, and the edge case or caveat a professor would add. Four to six sentences.
- If the passage is garbled transcription, say what it most likely meant and flag the uncertainty in one clause.
- Never invent lecture content that is not there. Textbook context is allowed only when clearly marked as background.
- Plain prose. No headings, no bullets, no markdown.`;

app.post('/api/explain', async (req, res) => {
  try {
    const { passage, context, mode, language } = req.body;
    if (!passage || typeof passage !== 'string' || !passage.trim()) {
      return res.status(400).json({ error: 'Missing passage' });
    }

    const which = mode === 'deeper' ? 'DEEPER' : 'SIMPLER';

    const response = await gemini.models.generateContent({
      model: LIVE_MODEL,
      contents:
        `Mode: ${which}\n\nHighlighted passage:\n"${passage}"\n\n` +
        `Surrounding transcript for context:\n${
          typeof context === 'string' && context.trim() ? context : '(no further context available)'
        }`,
      config: {
        systemInstruction: EXPLAIN_SYSTEM_PROMPT + languageDirective(language),
        temperature: 0.3,
        maxOutputTokens: 500,
      },
    });

    res.json({ answer: response.text?.trim() || '' });
  } catch (err: any) {
    console.error('[explain] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    deepgram: !!process.env.DEEPGRAM_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    model: SUMMARY_MODEL,
    liveModel: LIVE_MODEL,
  });
});

// ── Start ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3001', 10);
app.listen(PORT, () => {
  console.log(`Lecture AI server running on http://localhost:${PORT}`);
  console.log(`  Deepgram: ${process.env.DEEPGRAM_API_KEY ? 'configured' : 'MISSING'}`);
  console.log(`  Gemini: ${process.env.GEMINI_API_KEY ? 'configured' : 'MISSING'}`);
});