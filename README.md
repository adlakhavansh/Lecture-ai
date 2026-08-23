# Lecture AI

A live in-class assistant that sits in your Chrome side panel.

Most lecture tools are retrospective — they hand you a transcript after class is
over. This one is built for the student who is *in the room right now*: you
drifted for four minutes, the professor just asked you something, and you need
to know what you missed **before** you answer.

## What it does

While a lecture plays in a tab, the extension captures the audio, transcribes it
in near-real-time, and keeps a side panel current with:

- **Catch Me Up** — a rolling recap of the last 3, 7 or 15 minutes. Precomputed
  in the background, so tapping a rewind chip is instant.
- **Doubts you could ask** — real questions grounded in what was actually just
  said, ready for when the professor asks "any questions?" Refresh for a
  different angle; the ones you've seen are excluded from the next batch.
- **Glossary** — terms the professor used in the last few minutes, defined.
- **Assumed knowledge** — the things this stretch of lecture quietly expects you
  to already know ("as we saw with eigenvalues"), with a one-line refresher.
- **Ask box** — free-form questions answered from the running transcript.
- **Highlight to explain** — select any line in the transcript, recap or answer
  and ask for it *simpler* or *deeper*.
- **Live transcript** with clickable timestamps that seek the lecture video back
  to that moment.
- **Pause and resume** without ending the lecture — the timer and the transcript
  both stop cleanly for a break.
- **Any output language** — the professor can teach in English, Hindi or
  Hinglish while the panel answers you in the language you picked (12 options,
  including Hinglish).

### Two kinds of marked moment

There's one deliberate distinction in here, and it's the part that separates this
from a summariser: nothing decides on your behalf what mattered.

**You flag it.** Press **Alt+L** — or the flag button in the panel, in the popup,
or beside any transcript line — the moment you notice you've stopped following. A
flag reaches back about 45 seconds, because confusion is always noticed a beat
late; you realise you lost the thread somewhere behind where the voice now is.
Afterwards the summary opens with *You flagged this*: each moment quoted, with a
plain-language re-explanation. If the rest of the lecture made sense, that
section is the only part of the document you need to read. Most flagging actually
happens after class, skimming the transcript, so lines can be flagged there too
and re-explained on demand.

**They flag it.** Quizzes, deadlines, submission dates and marking schemes are
caught from the professor's own words — "in the exam", "due by", "note this
down", "carries marks". That's a string match, not a model judgement, which is
the point: a due date can't be quietly paraphrased away or dropped from a
summary because something else seemed more important. Each one appears in the
panel the second it's heard, and again under *Don't miss* in the summary, quoted
verbatim alongside the phrase that triggered it.

When you stop, you get a full transcript and a structured summary: TL;DR, key
points, how the lecture moved section by section, formulas and rules, terms,
worked examples, what the professor flagged as examinable, what was left open,
and a revision list. Every past lecture stays browsable in **History**.

## Setup

You have two options. Pick the first one.

### Option A — bring your own keys (no server)

Load the extension, open **Settings**, paste a Deepgram key and a Gemini key.
That's it — the extension talks to both APIs directly and nothing else needs to
run.

```bash
cd extension
npm install
npm run build               # → extension/dist/
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load
unpacked**, and select `extension/dist`. Click the extension icon → **Add your
keys**, paste them, hit **Test keys**.

Use `npm run build` — not any other path. `assemble.mjs` is the single source of
truth for the dist manifest.

### Option B — local proxy

If you'd rather keep keys out of the browser entirely, run the small Express
server and turn off *Call APIs directly* in Settings.

```bash
cd server
cp .env.example .env        # then paste in your Deepgram + Gemini keys
npm install
npm run dev                 # listens on http://localhost:3001
```

Sanity check: `curl http://localhost:3001/api/health` should report the models
in use. Both paths expose the same endpoints and the same behaviour, so you can
switch between them mid-project.

### Use it

Open your lecture tab, click the extension icon, hit **Start listening**. The
side panel opens on its own and starts filling in after roughly half a minute of
speech.

The one keystroke worth learning: **Alt+L** whenever you lose the thread. It
works from the panel, the popup and the browser itself, so you never have to go
find a button mid-sentence. The popup also shows a live count of what you've
flagged, what's waiting to be checked, and a two-line version of the recap —
enough to catch up without opening anything.

Worth doing once per course: in **Settings**, paste your course vocabulary into
the keyword box — lecturer name, module names, jargon. Deepgram weights those
terms up, which is what stops "Dijkstra" from being transcribed as "extra".

## Keys you need

| Key | Where from | Notes |
| --- | --- | --- |
| Deepgram | console.deepgram.com | nova-2, handles Hinglish well. Free tier is $200 ≈ 700+ hours. |
| Gemini | aistudio.google.com | Free tier is fine for a demo. |

## How it works

```
lecture tab audio
      │  chrome.tabCapture
      ▼
offscreen document ── VAD chunking (RMS gate, flush on 1.5s silence)
      │                └─ reports audio level 8×/sec → panel meter
      ▼
service worker ──► Deepgram nova-2 (direct, or via localhost:3001)
      │                                    │
      │◄────────── transcript segments ─────┘
      │                └─ failed chunk? re-queued, 3 attempts, backoff
      │
      ├─ every 75s ──► Gemini ──► one JSON object
      │                             │
      │                             ▼
      │                     side panel: topic, recap, doubts,
      │                     glossary, assumed knowledge
      │
      └─ on stop ───► Gemini ──► structured summary + history entry
```

Four design decisions worth knowing if you're extending it:

**One call feeds every card.** The 75-second loop makes a single Gemini request
that returns one JSON object containing the topic, recap, questions, terms and
assumed knowledge. Adding a new card is mostly a few lines in
`INSIGHTS_SYSTEM_PROMPT` (`extension/src/prompts.ts`, mirrored in
`server/index.ts`) plus a render function — not new plumbing.

**Nothing is generated on demand.** A five-second spinner is useless when you've
just been cold-called, so recaps are computed ahead of time and cached. The
panel only ever reads.

**The service worker assumes it will be killed.** MV3 evicts it after ~30s idle,
which wipes module state. Every handler calls `ensureSession()` first, which
rehydrates from `chrome.storage.session`; every mutation calls `persistSession()`.

**Alarms have a 30-second floor.** The insight loop uses a self-rescheduling
one-shot `chrome.alarms` entry rather than a periodic one, and the *first*
insight is additionally triggered by transcript length so you see something
before the 30s clamp expires.

## Layout

```
extension/
  src/
    background.ts        service worker — capture, queue, insight loop, history
    offscreen.ts         audio capture, VAD chunking, level metering
    apiDirect.ts         direct Deepgram + Gemini calls (BYOK path)
    prompts.ts           every system prompt, in one place
    settings.ts          keys, model, keywords, language, routing
    popup.*              launcher: start/stop/pause, open panel
    theme.css            design tokens, shared by every surface
    pages/
      panel.*            the live side panel
      transcript.*       full transcript, clickable timestamps
      summary.*          structured end-of-lecture summary
      history.*          past lectures, searchable
      settings.*         API keys and preferences
  assemble.mjs           writes dist manifest, copies static assets
server/                  optional proxy — same endpoints, keys stay on your machine
  index.ts               /api/transcribe /insights /ask /explain /summarize
```

## Notes

- `server/.env` in this archive contains real keys. **Do not commit it** — a key
  pushed to a public repo gets scraped within hours. `.gitignore` already lists
  it; check `git log` if you ever force-added it.
- Audio is only read while you're actively listening, and it is never stored.
  Transcripts and summaries stay in local extension storage; History keeps the
  last 50 lectures and you can delete any of them.
- Requires Chrome 114+ for the Side Panel API.
