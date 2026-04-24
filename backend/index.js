const express = require("express");
const cors    = require("cors");
const multer  = require("multer");
const Groq    = require("groq-sdk");
require("dotenv").config();

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────

const WHISPER_MODEL = "whisper-large-v3";
const CHAT_MODEL    = "openai/gpt-oss-120b";

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────

let lastUsedTypes      = [];
let lastSuggestionCall = 0;
const MIN_INTERVAL     = 5000; // ms — rate-limit auto-refreshes

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

// Build a Groq client using the key from the request header,
// falling back to the env var (optional server-side default).
function getGroq(req) {
  const apiKey = req.headers["x-groq-api-key"] || process.env.GROQ_API_KEY || "";
  if (!apiKey) return null;
  return new Groq({ apiKey });
}

// ─────────────────────────────────────────
// POST /transcribe
// Accepts: multipart/form-data, field "audio" (webm blob)
// Returns: { text: string }
// ─────────────────────────────────────────

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    const groq = getGroq(req);
    if (!groq)      return res.status(401).json({ error: "No API key provided" });
    if (!req.file)  return res.status(400).json({ error: "No audio file received" });

    // groq-sdk accepts a File-like object — wrap the multer buffer in a Blob + File
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || "audio/webm" });
    const file = new File([blob], "audio.webm",  { type: req.file.mimetype || "audio/webm" });

    const transcription = await groq.audio.transcriptions.create({
      file,
      model:           WHISPER_MODEL,
      response_format: "json",
    });

    res.json({ text: transcription.text ?? "" });
  } catch (err) {
    console.error("Transcribe error:", err?.message ?? err);
    res.status(500).json({ error: err?.message ?? "Transcription failed" });
  }
});

// ─────────────────────────────────────────
// POST /suggestions
// Body: { transcript: [{time,text}], force?: bool,
//         suggestionPrompt?: string, contextWords?: number }
// Returns: { suggestions: [{type,preview,detail}] }
// ─────────────────────────────────────────

app.post("/suggestions", async (req, res) => {
  try {
    const groq = getGroq(req);
    if (!groq) return res.status(401).json({ error: "No API key provided" });

    // Rate-limit auto-refreshes; manual force=true bypasses
    const now      = Date.now();
    const isManual = req.body.force === true;
    if (!isManual && now - lastSuggestionCall < MIN_INTERVAL) {
      return res.status(429).json({ error: "Too frequent — slow down" });
    }
    lastSuggestionCall = now;

    const { transcript, suggestionPrompt, contextWords = 500 } = req.body;
    if (!transcript?.length) return res.status(400).json({ error: "Transcript is required" });

    const recent = transcript
      .slice(-8)
      .map((t) => `[${t.time}] ${t.text}`)
      .join("\n");

    const avoidHint = lastUsedTypes.length
      ? `\nAvoid reusing these types from the previous batch: ${lastUsedTypes.join(", ")}.`
      : "";

    const systemPrompt = suggestionPrompt || `You are an expert real-time meeting copilot.
Generate EXACTLY 3 high-value live suggestions to help the user contribute better right now.

AVAILABLE TYPES:
QUESTION, ANSWER, CLARIFICATION, FACT_CHECK, TALKING_POINT, NEXT_STEP, QUICK_ANSWER, CONTEXT

TYPE DEFINITIONS:
- QUESTION: a sharp question the user could ask next
- ANSWER: a direct, substantive response to something just raised
- CLARIFICATION: resolve ambiguity, confusion, or vague language
- FACT_CHECK: identify a claim that should be verified
- TALKING_POINT: a relevant point, risk, tradeoff, or perspective to raise
- NEXT_STEP: a concrete action, owner, or follow-up
- QUICK_ANSWER: a short direct answer to a question just asked
- CONTEXT: useful background, definition, or framing that helps right now

STRICT RULES:
1. Return EXACTLY 3 suggestions — no more, no fewer.
2. Each suggestion MUST use a different type — never repeat within a batch.
3. Focus on the latest 5-10 utterances.
4. "preview" = 2 complete sentences, specific and useful even without clicking.
5. "detail" = 2-3 sentences with specifics, context, or actionable steps. NEVER leave it empty.
6. If a question was just asked → include QUICK_ANSWER or ANSWER.
7. If a decision is forming → include NEXT_STEP.
8. If something was ambiguous → include CLARIFICATION.
9. Return ONLY a valid JSON array — no markdown, no prose outside JSON.
${avoidHint}

Format (JSON array):
[
  {"type":"TYPE_1","preview":"Sentence one. Sentence two.","detail":"Expansion one. Two. Three."},
  {"type":"TYPE_2","preview":"...","detail":"..."},
  {"type":"TYPE_3","preview":"...","detail":"..."}
]`;

    const completion = await groq.chat.completions.create({
      model:       CHAT_MODEL,
      max_tokens:  800,
      temperature: 0.5,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: `Meeting transcript (recent):\n${recent}\n\nGenerate exactly 3 suggestions now.` },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "";

    let suggestions;
    try {
      const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
      const parsed  = JSON.parse(cleaned);
      suggestions   = Array.isArray(parsed) ? parsed : (parsed.suggestions ?? []);
      if (!suggestions.length) throw new Error("empty array");
      suggestions   = suggestions.slice(0, 3);
    } catch {
      console.error("JSON parse error:", raw);
      return res.status(500).json({ error: "Model returned invalid JSON" });
    }

    // Track used types so next batch can vary
    lastUsedTypes = suggestions.map((s) => s.type);

    res.json({ suggestions });
  } catch (err) {
    console.error("Suggestions error:", err?.message ?? err);
    if (err?.status === 429) return res.status(429).json({ error: "Rate limit — please wait" });
    res.status(500).json({ error: err?.message ?? "Failed to generate suggestions" });
  }
});

// ─────────────────────────────────────────
// POST /chat
// Body: { transcript, message, history?, chatPrompt?, contextWords? }
// Returns: { answer: string }
// ─────────────────────────────────────────

app.post("/chat", async (req, res) => {
  try {
    const groq = getGroq(req);
    if (!groq) return res.status(401).json({ error: "No API key provided" });

    const { transcript, message, history = [], chatPrompt, contextWords = 600 } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });

    const ctx = (transcript ?? [])
      .map((t) => t.text)
      .join(" ")
      .split(" ")
      .slice(-contextWords)
      .join(" ");

    const systemContent =
      (chatPrompt ||
        `You are a concise live meeting assistant. Answer using the meeting transcript as context.

FORMAT — always follow this exactly:
- Write 3 to 5 bullet points using plain dashes (-)
- Each bullet is one short sentence — maximum 15 words
- No paragraphs, no walls of text, no headers
- No bold, no italic, no markdown tables
- No filler ("Sure!", "Great question!", "Certainly!")
- If the answer has a single clear fact, write just 1-2 bullets
- Start the first word of every bullet with a capital letter

CONTENT rules:
- Answer directly from the transcript when possible
- If the transcript doesn't cover it, say so in one bullet then answer from general knowledge
- Be specific — name concrete things, numbers, people when relevant
- Maximum 5 bullets total, no exceptions`) +
      `\n\nMeeting transcript so far:\n${ctx || "none"}`;

    const messages = [
      { role: "system", content: systemContent },
      ...history,
      { role: "user",   content: message },
    ];

    const completion = await groq.chat.completions.create({
      model:       CHAT_MODEL,
      max_tokens:  600,
      temperature: 0.5,
      messages,
    });

    res.json({ answer: completion.choices[0]?.message?.content?.trim() ?? "" });
  } catch (err) {
    console.error("Chat error:", err?.message ?? err);
    res.status(500).json({ error: err?.message ?? "Chat failed" });
  }
});

// ─────────────────────────────────────────
// POST /expand
// Body: { transcript, suggestion, expandPrompt?, contextWords? }
// Returns: { answer: string }
// ─────────────────────────────────────────

app.post("/expand", async (req, res) => {
  try {
    const groq = getGroq(req);
    if (!groq) return res.status(401).json({ error: "No API key provided" });

    const { transcript, suggestion, expandPrompt, contextWords = 800 } = req.body;
    if (!suggestion) return res.status(400).json({ error: "Suggestion is required" });

    const ctx = (transcript ?? [])
      .map((t) => t.text)
      .join(" ")
      .split(" ")
      .slice(-contextWords)
      .join(" ");

    const systemContent =
      expandPrompt ||
      `You are a meeting assistant. The user clicked a suggestion card. Answer in bullet points only.
 
      STRICT FORMAT — no exceptions:
      - Use plain dashes (-) for every bullet
      - 4 to 6 bullets maximum
      - Each bullet: one concrete sentence, under 20 words
      - First bullet: direct answer or key insight
      - Remaining bullets: supporting context, steps, or specifics from the transcript
      - No paragraphs. No prose. No walls of text. Ever.
      - No bold, no headers, no markdown tables
      - No preamble ("Sure!", "Certainly!") — start first bullet immediately
       
      EXAMPLE of correct output:
      - The main risk is algorithmic bias from unrepresentative training data.
      - Bias can cause unfair outcomes in hiring, lending, and medical diagnosis.
      - Mitigation requires diverse datasets and regular audits of model outputs.
      - Assign a responsible AI lead to oversee compliance and fairness reviews.
       
      If you write a paragraph instead of bullets, you have failed.`;

    const completion = await groq.chat.completions.create({
      model:      CHAT_MODEL,
      max_tokens: 700,
      messages: [
        { role: "system", content: systemContent },
        {
          role:    "user",
          content: `Full transcript context:\n${ctx || "none"}\n\nSuggestion clicked:\nType: ${suggestion.type}\nPreview: ${suggestion.preview}\nDetail: ${suggestion.detail}\n\nProvide a detailed, actionable response.`,
        },
      ],
    });

    res.json({ answer: completion.choices[0]?.message?.content?.trim() ?? "" });
  } catch (err) {
    console.error("Expand error:", err?.message ?? err);
    res.status(500).json({ error: err?.message ?? "Expand failed" });
  }
});

// ─────────────────────────────────────────
// GET /  — health check
// ─────────────────────────────────────────

app.get("/", (_req, res) => res.json({ status: "ok", model: CHAT_MODEL }));

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT}`));