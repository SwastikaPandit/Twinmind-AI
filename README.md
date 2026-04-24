# 🎙️ Meeting Copilot

> A real-time AI meeting assistant that listens, transcribes, and surfaces **3 contextual suggestions** every 30 seconds — powered by Groq.

## 📸 Preview
--------------------------------------------------------------------------------------------
|   Column                |           What it does                                         |  
--------------------------------------------------------------------------------------------
| 🎤 **Transcript**       |    Live mic recording, speech-to-text every 30s via Whisper    |
| 💡 **Live Suggestions** | 3 fresh contextual suggestions after every transcript chunk    |
| 💬 **Chat**             | Click a suggestion or type — get detailed bullet-point answers |
-------------------------------------------------------------------------------------------


## ✨ Features

- 🎤 **Start/stop mic** — records audio in 30s chunks
- 📝 **Live transcript** — appends and auto-scrolls as you speak
- 💡 **3 suggestions per batch** — QUESTION, ANSWER, CLARIFICATION, FACT_CHECK, TALKING_POINT, NEXT_STEP, QUICK_ANSWER, CONTEXT
- 🔄 **Auto-refresh every 30s** with countdown timer
- 🖱️ **Click any suggestion** for a detailed expanded answer
- 💬 **Direct chat** — type questions anytime
- 📤 **Export** full session as JSON (transcript + batches + chat)
- ⚙️ **Settings panel** — edit all prompts, context sizes, API key

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Free Groq API key → [console.groq.com](https://console.groq.com)

### 1. Clone
```bash
git clone https://github.com/SwastikaPandit/Twinmind-AI.git
cd Twinmind-AI
```

### 2. Backend
```bash
cd backend
npm install
```

Create `backend/.env`:
```env
PORT=5001
GROQ_API_KEY=   # optional fallback — users paste their own in the UI
```

```bash
npm run dev
# 🚀 Server on http://localhost:5001
```

### 3. Frontend
```bash
cd frontend
npm install
```

Create `frontend/.env`:
```env
VITE_API_URL=http://localhost:5001
```

```bash
npm run dev
# → http://localhost:5173
```

Open the app → click ⚙️ Settings → paste your Groq key → click the mic 🎤

---

## 🏗️ Architecture

```
Browser
  │
  ├─ MediaRecorder (30s chunks)
  │     └─ POST /transcribe ──► Groq Whisper Large V3
  │                                    │
  │           ◄── { text } ────────────┘
  │                │
  │    Immediately fires ↓
  │
  ├─ POST /suggestions ──────► Groq openai/gpt-oss-120b
  │     ◄── { suggestions[3] } ──────────┘
  │
  ├─ POST /expand  (card click) ──► Groq openai/gpt-oss-120b
  │
  └─ POST /chat    (direct input) ─► Groq openai/gpt-oss-120b
```

All Groq calls go through the **Express backend**. The user's API key travels as `x-groq-api-key` header — never stored, never logged.

---

## 🛠️ Stack
--------------------------------------------------------------------------------------
| Layer              | Choice                | Why                                   |
|--------------------|-----------------------|---------------------------------------|
| Frontend           | React + Vite          | Fast HMR, minimal config              |
| Backend            | Node.js + Express     | Thin proxy, keeps API key server-side |
| Transcription      | Groq Whisper Large V3 | Fastest Whisper endpoint available    |
| Suggestions + Chat | `openai/gpt-oss-120b` | Required by spec                      |
| Audio              | MediaRecorder API     | Native browser, zero extra deps       |
| Deploy (backend)   | Render                | Free tier, auto-deploys from GitHub   |
| Deploy (frontend)  | Vercel                | Free tier, auto-deploys from GitHub   |
--------------------------------------------------------------------------------------


## 🧠 Prompt Strategy

### 💡 Live Suggestions

**Context passed:** last 8 transcript chunks with timestamps (~500 words)

**8 suggestion types with strict definitions:**

---------------------------------------------------------------
| Type            | When to use                                |
|-----------------|--------------------------------------------|
| `QUESTION`      | Sharp question to ask next                 |
| `ANSWER`        | Direct response to something just raised   |
| `CLARIFICATION` | Resolve ambiguity or vague language        |
| `FACT_CHECK`    | Flag a claim that should be verified       |
| `TALKING_POINT` | Relevant point, risk, or tradeoff to raise |
| `NEXT_STEP`     | Concrete action or owner                   |
| `QUICK_ANSWER`  | Short answer to a question just asked      |
| `CONTEXT`       | Background or framing useful right now     |
---------------------------------------------------------------

**Key rules enforced in the prompt:**
- Exactly 3 suggestions, each a **different type**
- `preview` = 2 complete sentences — useful even without clicking
- `detail` = 2-3 sentences with specifics — **never empty**
- If a question was just asked → prefer `QUICK_ANSWER`
- If a decision is forming → prefer `NEXT_STEP`
- If something was ambiguous → prefer `CLARIFICATION`

**Diversity mechanism:** `lastUsedTypes` is tracked server-side. Each new prompt is told to avoid repeating the previous batch's types — this drives variety across batches throughout a meeting.

### 🖱️ Expand on Click

- Context: last ~800 words + full suggestion card
- Format: 4-6 bullet points, one sentence each, no paragraphs

### 💬 Direct Chat

- Context: last ~600 words embedded in system prompt + full multi-turn history
- Format: 3-5 bullet points, plain dashes, no prose
- Transcript goes in the **system prompt** (not as a user message) to avoid consecutive same-role errors on the Groq API

---

## ⚙️ Settings (all editable in UI)
-----------------------------------------------------------------------------
| Setting             | Default           | Purpose                         |
|---------------------|-------------------|---------------------------------|
| Groq API Key        | —                 | User-provided, never stored     |
| Suggestion Context  | 500 words         | Transcript sent for suggestions |
| Expand Context      | 800 words         | Transcript sent on card click   |
| Chat Context        | 600 words         | Transcript included in chat     |
| Suggestion Prompt   | Optimised default | Full system prompt              |
| Expand Prompt       | Optimised default | System prompt for expansion     |
| Chat Prompt         | Optimised default | System prompt for chat          |
-----------------------------------------------------------------------------

---

## 🔌 API Endpoints
-------------------------------------------------------------------------------------------------------------------
| Method |      Path      |                            Body                                 |       Returns        |
|--------|----------------|-----------------------------------------------------------------|----------------------|
| `POST` | `/transcribe`  | `multipart/form-data` — `audio` field                           | `{ text }`           |
| `POST` | `/suggestions` | `{ transcript, suggestionPrompt?, contextWords? }`              | `{ suggestions[3] }` |
| `POST` | `/chat`        | `{ transcript, message, history?, chatPrompt?, contextWords? }` | `{ answer }`         |
| `POST` | `/expand`      | `{ transcript, suggestion, expandPrompt?, contextWords? }`      | `{ answer }`         |
| `GET`  | `/`            |       —                                                         | `{ status, model }`  |
--------------------------------------------------------------------------------------------------------------------

## ⚡ Key Engineering Decisions

**Why route through a backend?**
API key is never exposed in the browser network tab. The `lastUsedTypes` diversity state also lives server-side — if it were in the frontend it would reset on every page reload.

**Why `transcriptRef` instead of `transcript` state in callbacks?**
`useCallback` with empty deps captures stale state at mount. All async callbacks read from refs kept in sync via `useEffect`.

**Why build the transcript array outside `setTranscript`'s updater?**
React StrictMode calls state updater functions twice. Calling `getSuggestions()` inside the updater caused two API calls → two duplicate batches. Building outside and calling `setTranscript(updated)` avoids the double-invoke.

**Why arm the suggestion interval inside `transcribeChunk`?**
At mic start the transcript is empty — `getSuggestions([])` produces nothing. Starting the 30s countdown from when first text arrives means the timer reflects actual time-since-last-content.

**Function refs for cross-callback calls**
`transcribeChunk` is defined before `getSuggestions`. Using `getSuggestionsRef` and `armSuggestionIntervalRef` (assigned right after each function is defined) prevents `undefined` closure capture.

---

## ⚖️ Tradeoffs
----------------------------------------------------------------------------------------------
|            Decision              |                        Tradeoff                         |
|----------------------------------|---------------------------------------------------------|
| 30s audio chunks                 | Simpler than streaming; ~30s before first suggestions   |
| `lastUsedTypes` in server memory | Resets on server restart; fine for demo                 |
| No response streaming            | Simpler code; Groq latency ~1-2s is acceptable          |
| Bullet format enforced in prompt | Occasionally model still writes prose on complex topics |
| Free tier on Render              | Server sleeps after 15 min idle; first wake takes ~30s  |
----------------------------------------------------------------------------------------------


## 🌐 Deployment
--------------------------------------------------------------
|       Service     |                       URL               |
|-------------------|-----------------------------------------|
| Frontend (Vercel) | https://twinmind-ai-mocha.vercel.app    |
| Backend (Render)  | https://project-meeting-ai.onrender.com |
---------------------------------------------------------------

> **Note:** Render free tier sleeps after 15 minutes of inactivity. First request after idle takes ~30 seconds to wake up.

