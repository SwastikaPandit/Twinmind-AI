import { useState, useRef, useEffect, useCallback } from "react";
import "./App.css";

// ─────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────

const BASE_URL            = import.meta.env.VITE_API_URL || "http://localhost:5001";
const CHUNK_INTERVAL_MS   = 30000; // 30 s audio chunks → Whisper
const SUGGESTION_INTERVAL = 30000; // 30 s auto-suggestion refresh

// ─────────────────────────────────────────
// DEFAULT SETTINGS  (shown in Settings panel, all editable)
// ─────────────────────────────────────────

const DEFAULT_SETTINGS = {
  apiKey: "", // user pastes their Groq key — never hard-coded

  suggestionContextWords: 500,
  expandContextWords:     800,
  chatContextWords:       600,

  // Default prompts — shown in Settings so user can read and edit them
  suggestionPrompt: `You are an expert real-time meeting copilot.
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

Format:
[
  {"type":"TYPE_1","preview":"Sentence one. Sentence two.","detail":"Expansion one. Two. Three."},
  {"type":"TYPE_2","preview":"...","detail":"..."},
  {"type":"TYPE_3","preview":"...","detail":"..."}
]`,

  expandPrompt: `You are a meeting assistant. The user clicked a suggestion card. Answer in bullet points only.
 
  STRICT FORMAT — no exceptions:
  - Use plain dashes (-) for every bullet
  - 6 to 10 bullets maximum
  - Each bullet: one concrete sentence, under 20 words
  - First bullet: direct answer or key insight
  - Remaining bullets: supporting context, steps, or specifics from the transcript
  - No paragraphs. No prose. No walls of text. Ever.
  - No bold, no headers, no markdown tables
  - Frist letter capital
  - No preamble ("Sure!", "Certainly!") — start first bullet immediately
   
  EXAMPLE of correct output:
  - The main risk is algorithmic bias from unrepresentative training data.
  - Bias can cause unfair outcomes in hiring, lending, and medical diagnosis.
  - Mitigation requires diverse datasets and regular audits of model outputs.
  - Assign a responsible AI lead to oversee compliance and fairness reviews.
   
  If you write a paragraph instead of bullets, you have failed.`,

  chatPrompt: `You are a live meeting assistant. You MUST answer in bullet points only.

  STRICT OUTPUT FORMAT — no exceptions:
  - Use plain dashes (-) for every bullet
  - 3 to 5 bullets maximum
  - Each bullet: one sentence, under 20 words
  - No paragraphs. No prose. No walls of text. Ever.
  - No bold, no headers, no markdown
  - No filler words ("Sure!", "Certainly!", "Great question!")
  
  EXAMPLE of correct output:
  - AI refers to systems that mimic human reasoning and learning.
  - Main advantages are speed, scalability, and pattern recognition.
  - Key risks include bias in training data and lack of transparency.
  - Start with the most important point first.
  
  If you write a paragraph instead of bullets, you have failed. Always use the dash-bullet format above.`,
};

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

function nowTime() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function nowDate() {
  return new Date().toLocaleDateString([], {
    month: "short", day: "2-digit", year: "numeric",
  });
}

// ─────────────────────────────────────────
// APP
// ─────────────────────────────────────────

export default function App() {

  // ── State ──
  const [transcript,    setTranscript]    = useState([]);
  const [batches,       setBatches]       = useState([]);
  const [batchCount,    setBatchCount]    = useState(0);
  const [chat,          setChat]          = useState([]);
  const [chatHistory,   setChatHistory]   = useState([]);
  const [userInput,     setUserInput]     = useState("");
  const [loading,       setLoading]       = useState(false);
  const [isRecording,   setIsRecording]   = useState(false);
  const [sessionName,   setSessionName]   = useState("My Meeting");
  const [editingName,   setEditingName]   = useState(false);
  const [tempName,      setTempName]      = useState("My Meeting");
  const [showSettings,  setShowSettings]  = useState(false);
  const [settings,      setSettings]      = useState(DEFAULT_SETTINGS);
  const [draft,         setDraft]         = useState(DEFAULT_SETTINGS);
  const [statusMsg,     setStatusMsg]     = useState("");
  const [suggestLoading,setSuggestLoading]= useState(false);
  const [nextRefreshIn, setNextRefreshIn] = useState(null);

  // ── Refs ──
  const transcriptEndRef = useRef(null);
  const chatEndRef       = useRef(null);
  const nameInputRef     = useRef(null);
  const isRecordingRef   = useRef(false);   // live value — avoids stale closure
  const mediaRecorderRef = useRef(null);
  const audioChunksRef   = useRef([]);
  const chunkTimerRef    = useRef(null);
  const suggestTimerRef  = useRef(null);
  const countdownRef     = useRef(null);
  const streamRef        = useRef(null);
  const transcriptRef    = useRef([]);      // live value — avoids stale closure
  const settingsRef      = useRef(DEFAULT_SETTINGS); // live value
  const chatHistoryRef   = useRef([]);      // live value
  // Function refs — let transcribeChunk call getSuggestions/armSuggestionInterval
  // even though they are defined after it (avoids undefined closure capture)
  const getSuggestionsRef       = useRef(null);
  const armSuggestionIntervalRef = useRef(null);

  // Keep refs in sync with state
  useEffect(() => { transcriptRef.current  = transcript;  }, [transcript]);
  useEffect(() => { settingsRef.current    = settings;    }, [settings]);
  useEffect(() => { chatHistoryRef.current = chatHistory; }, [chatHistory]);

  // ── Auto-scroll ──
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);

  // ── Unmount cleanup ──
  useEffect(() => {
    return () => {
      clearTimeout(chunkTimerRef.current);
      clearInterval(suggestTimerRef.current);
      clearInterval(countdownRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // ══════════════════════════════════════
  //  API HELPER  — attaches key header for every backend call
  // ══════════════════════════════════════

  function apiHeaders(extraHeaders = {}) {
    const key = settingsRef.current.apiKey;
    return {
      ...(key ? { "x-groq-api-key": key } : {}),
      ...extraHeaders,
    };
  }

  // ══════════════════════════════════════
  //  TRANSCRIBE  →  POST /transcribe
  // ══════════════════════════════════════

  const transcribeChunk = useCallback(async (blob) => {
    if (!blob || blob.size < 1000) return;

    const { apiKey } = settingsRef.current;
    if (!apiKey) { setStatusMsg("⚠ No API key — open Settings"); return; }

    setStatusMsg("Transcribing…");

    const form = new FormData();
    form.append("audio", blob, "audio.webm");

    try {
      const res  = await fetch(`${BASE_URL}/transcribe`, {
        method:  "POST",
        headers: apiHeaders(), // Content-Type set automatically for FormData
        body:    form,
      });
      const data = await res.json();

      if (!res.ok) {
        setStatusMsg(`Transcription error: ${data.error ?? res.status}`);
        return;
      }

      if (data.text?.trim()) {
        const newLine = { date: nowDate(), time: nowTime(), text: data.text.trim() };
        // Build array outside state updater — avoids StrictMode double-invoke bug
        const updated = [...transcriptRef.current, newLine];
        setTranscript(updated);
        getSuggestionsRef.current?.(updated);        // immediate suggestions on new transcript text
        armSuggestionIntervalRef.current?.();        // reset 30 s auto-refresh from this moment
      }
      setStatusMsg("");
    } catch (err) {
      console.error("Transcribe error:", err);
      setStatusMsg("Transcription failed — is the backend running?");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // getSuggestions / armSuggestionInterval read via closure after hoisting

  // ══════════════════════════════════════
  //  SUGGESTIONS  →  POST /suggestions
  // ══════════════════════════════════════

  const getSuggestions = useCallback(async (lines) => {
    if (!lines?.length) return;
    const s = settingsRef.current;
    if (!s.apiKey) return;

    setSuggestLoading(true);

    try {
      const res  = await fetch(`${BASE_URL}/suggestions`, {
        method:  "POST",
        headers: apiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          transcript:       lines,
          suggestionPrompt: s.suggestionPrompt || undefined,
          contextWords:     s.suggestionContextWords,
          force:            true, // frontend always passes force; rate-limit is backend's job
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        console.warn("Suggestions error:", data.error);
        return;
      }

      if (!Array.isArray(data.suggestions) || data.suggestions.length === 0) return;

      const items = data.suggestions.slice(0, 3);
      setBatches((prev) => [{ time: nowTime(), items }, ...prev]);
      setBatchCount((prev) => prev + 1);
    } catch (err) {
      console.error("Suggestions error:", err);
    } finally {
      setSuggestLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // stable — reads settings via ref
  getSuggestionsRef.current = getSuggestions; // keep ref up to date

  // ══════════════════════════════════════
  //  ARM 30 s INTERVAL
  //  Called after each new transcript chunk arrives.
  //  Clears any previous timer so only one interval runs at a time.
  // ══════════════════════════════════════

  const armSuggestionInterval = useCallback(() => {
    clearInterval(suggestTimerRef.current);
    clearInterval(countdownRef.current);

    setNextRefreshIn(SUGGESTION_INTERVAL / 1000);

    suggestTimerRef.current = setInterval(() => {
      getSuggestionsRef.current?.(transcriptRef.current);
      setNextRefreshIn(SUGGESTION_INTERVAL / 1000);
    }, SUGGESTION_INTERVAL);

    countdownRef.current = setInterval(() => {
      setNextRefreshIn((prev) => (prev !== null && prev > 1 ? prev - 1 : prev));
    }, 1000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // stable — getSuggestions read via ref at call time
  armSuggestionIntervalRef.current = armSuggestionInterval; // keep ref up to date

  const stopSuggestionCycle = useCallback(() => {
    clearInterval(suggestTimerRef.current);
    clearInterval(countdownRef.current);
    suggestTimerRef.current = null;
    countdownRef.current    = null;
    setNextRefreshIn(null);
  }, []);

  // Manual refresh: fire now + reset countdown
  const handleManualRefresh = useCallback(() => {
    getSuggestionsRef.current?.(transcriptRef.current);
    armSuggestionIntervalRef.current?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ══════════════════════════════════════
  //  CHUNK CYCLE  (30 s MediaRecorder loop)
  // ══════════════════════════════════════

  const startChunkCycle = useCallback((stream) => {
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    function createRecorder() {
      if (!isRecordingRef.current) return;

      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data?.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        transcribeChunk(blob);
        audioChunksRef.current = [];

        if (!isRecordingRef.current) {
          streamRef.current?.getTracks().forEach((t) => t.stop());
          streamRef.current        = null;
          mediaRecorderRef.current = null;
          return;
        }
        setTimeout(createRecorder, 100);
      };

      recorder.start();
      mediaRecorderRef.current = recorder;

      chunkTimerRef.current = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, CHUNK_INTERVAL_MS);
    }

    createRecorder();
  }, [transcribeChunk]);

  // ══════════════════════════════════════
  //  MIC TOGGLE
  // ══════════════════════════════════════

  const toggleMic = async () => {
    if (isRecording) {
      isRecordingRef.current = false; // flip BEFORE stop() so onstop sees false
      setIsRecording(false);
      clearTimeout(chunkTimerRef.current);
      stopSuggestionCycle();
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      setStatusMsg("");
      return;
    }

    if (!settingsRef.current.apiKey) {
      setShowSettings(true);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current      = stream;
      isRecordingRef.current = true; // flip BEFORE startChunkCycle so first guard passes
      setIsRecording(true);
      setStatusMsg("Recording…");
      startChunkCycle(stream);
      // Suggestion cycle arms itself inside transcribeChunk once first text arrives
    } catch (err) {
      alert("Microphone access denied: " + err.message);
    }
  };

  // ══════════════════════════════════════
  //  EXPAND SUGGESTION  →  POST /expand
  // ══════════════════════════════════════

  const expandSuggestion = async (suggestion) => {
    setLoading(true);
    setChat((prev) => [
      ...prev,
      { role: "user", text: suggestion.preview, msgType: suggestion.type, timestamp: nowTime() },
    ]);

    const s = settingsRef.current;

    try {
      const res  = await fetch(`${BASE_URL}/expand`, {
        method:  "POST",
        headers: apiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          transcript:   transcriptRef.current,
          suggestion,
          expandPrompt: s.expandPrompt || undefined,
          contextWords: s.expandContextWords,
        }),
      });
      const data   = await res.json();
      const answer = res.ok
        ? (data.answer || "No answer returned.")
        : (data.error  || "Error from server.");

      setChat((prev) => [
        ...prev,
        { role: "ai", text: answer, msgType: "", timestamp: nowTime() },
      ]);
      setChatHistory((prev) => [
        ...prev,
        { role: "user",      content: suggestion.preview },
        { role: "assistant", content: answer },
      ]);
    } catch (err) {
      console.error("Expand error:", err);
      setChat((prev) => [
        ...prev,
        { role: "ai", text: "Network error — is the backend running?", msgType: "", timestamp: nowTime() },
      ]);
    }

    setLoading(false);
  };

  // ══════════════════════════════════════
  //  CHAT  →  POST /chat
  // ══════════════════════════════════════

  const sendMessage = async (message) => {
    if (!message.trim() || loading) return;

    setLoading(true);
    setChat((prev) => [
      ...prev,
      { role: "user", text: message, msgType: "", timestamp: nowTime() },
    ]);

    const s = settingsRef.current;

    try {
      const res  = await fetch(`${BASE_URL}/chat`, {
        method:  "POST",
        headers: apiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          transcript:   transcriptRef.current,
          message,
          history:      chatHistoryRef.current, // full multi-turn history
          chatPrompt:   s.chatPrompt || undefined,
          contextWords: s.chatContextWords,
        }),
      });
      const data   = await res.json();
      const answer = res.ok
        ? (data.answer || "No answer returned.")
        : (data.error  || "Error from server.");

      setChat((prev) => [
        ...prev,
        { role: "ai", text: answer, msgType: "", timestamp: nowTime() },
      ]);
      setChatHistory((prev) => [
        ...prev,
        { role: "user",      content: message },
        { role: "assistant", content: answer },
      ]);
    } catch (err) {
      console.error("Chat error:", err);
      setChat((prev) => [
        ...prev,
        { role: "ai", text: "Network error — is the backend running?", msgType: "", timestamp: nowTime() },
      ]);
    }

    setLoading(false);
  };

  // ══════════════════════════════════════
  //  SETTINGS
  // ══════════════════════════════════════

  const openSettings   = () => { setDraft({ ...settings }); setShowSettings(true); };
  const saveSettings   = () => { setSettings({ ...draft }); setShowSettings(false); };
  const cancelSettings = () => setShowSettings(false);

  // ══════════════════════════════════════
  //  EXPORT
  // ══════════════════════════════════════

  const downloadJSON = () => {
    const payload = {
      session:           { name: sessionName, exportedAt: new Date().toISOString() },
      transcript,
      suggestionBatches: batches.map((b, i) => ({
        batchNumber: batches.length - i,
        time:        b.time,
        suggestions: b.items,
      })),
      chat: chat.map((c) => ({
        role:      c.role,
        type:      c.msgType || "",
        timestamp: c.timestamp || "",
        text:      c.text,
      })),
    };
    const a = Object.assign(document.createElement("a"), {
      href:     URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
      ),
      download: `${sessionName.replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}.json`,
    });
    a.click();
  };

  // ══════════════════════════════════════
  //  TYPE → display metadata
  // ══════════════════════════════════════

  const TYPE_META = {
    QUESTION:      { label: "Question",      color: "#8b5cf6" },
    ANSWER:        { label: "Answer",        color: "#10b981" },
    CLARIFICATION: { label: "Clarification", color: "#f59e0b" },
    FACT_CHECK:    { label: "Fact Check",    color: "#ef4444" },
    TALKING_POINT: { label: "Talking Point", color: "#4f8ef7" },
    NEXT_STEP:     { label: "Next Step",     color: "#06b6d4" },
    QUICK_ANSWER:  { label: "Quick Answer",  color: "#84cc16" },
    CONTEXT:       { label: "Context",       color: "#f97316" },
  };

  // ══════════════════════════════════════
  //  RENDER
  // ══════════════════════════════════════

  return (
    <div className="root-layout">

      {/* ── NAVBAR ── */}
      <div className="navbar">
        <div className="navbar-left">
          {editingName ? (
            <input
              ref={nameInputRef}
              className="name-edit-input"
              value={tempName}
              onChange={(e) => setTempName(e.target.value)}
              onBlur={() => { setSessionName(tempName || "My Meeting"); setEditingName(false); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { setSessionName(tempName || "My Meeting"); setEditingName(false); }
              }}
            />
          ) : (
            <h1 className="project-title" title="Click to rename"
              onClick={() => { setTempName(sessionName); setEditingName(true); }}>
              {sessionName}
            </h1>
          )}
        </div>
        <div className="navbar-right">
          <span className="nav-item">Transcript</span>
          <span className="nav-dot">·</span>
          <span className="nav-item">Live Suggestions</span>
          <span className="nav-dot">·</span>
          <span className="nav-item">Chat</span>
          <span className="nav-dot">·</span>
          <button onClick={openSettings} className="nav-btn">⚙ Settings</button>
          <button onClick={downloadJSON} className="nav-btn">⬇ Export</button>
        </div>
      </div>

      {/* ── SETTINGS MODAL ── */}
      {showSettings && (
        <div className="settings-overlay" onClick={cancelSettings}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="settings-title">⚙ Settings</h2>

            <div className="settings-group">
              <label className="settings-label">Groq API Key</label>
              <input
                className="settings-input" type="password" placeholder="gsk_…"
                value={draft.apiKey}
                onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              />
              <p className="settings-hint">
                Get a free key at{" "}
                <a href="https://console.groq.com" target="_blank" rel="noreferrer">console.groq.com</a>
              </p>
            </div>

            <div className="settings-row">
              {[
                ["Suggestion Context (words)", "suggestionContextWords"],
                ["Expand Context (words)",     "expandContextWords"],
                ["Chat Context (words)",       "chatContextWords"],
              ].map(([label, key]) => (
                <div className="settings-field" key={key}>
                  <label className="settings-label">{label}</label>
                  <input className="settings-input" type="number" min={50} max={2000}
                    value={draft[key]}
                    onChange={(e) => setDraft((d) => ({ ...d, [key]: Number(e.target.value) }))}
                  />
                </div>
              ))}
            </div>

            {[
              ["Live Suggestion Prompt",   "suggestionPrompt"],
              ["Expand (On-Click) Prompt", "expandPrompt"],
              ["Chat System Prompt",       "chatPrompt"],
            ].map(([label, key]) => (
              <div className="settings-group" key={key}>
                <label className="settings-label">{label}</label>
                <textarea className="settings-textarea" rows={5}
                  value={draft[key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                />
              </div>
            ))}

            <div className="settings-actions">
              <button className="settings-cancel" onClick={cancelSettings}>Cancel</button>
              <button className="settings-save"   onClick={saveSettings}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 3-COLUMN LAYOUT ── */}
      <div className="app-container">

        {/* LEFT: MIC + TRANSCRIPT */}
        <div className="column">
          <div className="panel">
            <div className="panel-header">
              <h2>1. MIC &amp; TRANSCRIPT</h2>
              <span className={`status-badge ${isRecording ? "status-recording" : ""}`}>
                {isRecording ? "● REC" : "IDLE"}
              </span>
            </div>

            <div className="mic-container">
              <button
                className={`mic-button ${isRecording ? "mic-active" : ""}`}
                onClick={toggleMic}
                title={isRecording ? "Stop recording" : "Start recording"}
              >
                <div className={`mic-dot ${isRecording ? "recording" : ""}`} />
              </button>
              <div className="mic-info">
                <p className="mic-hint">
                  {isRecording ? "Recording… click to stop." : "Click mic to start."}
                </p>
                {statusMsg && <p className="mic-status">{statusMsg}</p>}
                {!settings.apiKey && !isRecording && (
                  <p className="warn-no-key">⚠ No API key — open Settings first.</p>
                )}
              </div>
            </div>

            <div className="transcript-box">
              {transcript.length === 0 ? (
                <p className="empty-msg">
                  {isRecording
                    ? "Listening… transcript updates every 30 s."
                    : "No transcript yet — start the mic."}
                </p>
              ) : (
                transcript.map((entry, i) => (
                  <div key={i} className="transcript-entry">
                    <span className="transcript-time">{entry.time}</span>
                    <span className="transcript-text">{entry.text}</span>
                  </div>
                ))
              )}
              <div ref={transcriptEndRef} />
            </div>
          </div>
        </div>

        {/* MIDDLE: LIVE SUGGESTIONS */}
        <div className="column">
          <div className="panel">
            <div className="panel-header">
              <h2>2. LIVE SUGGESTIONS</h2>
              <span className="status-badge">{batchCount} {batchCount === 1 ? "BATCH" : "BATCHES"}</span>
            </div>

            <div className="suggestion-controls">
              <button
                className={`refresh-btn ${suggestLoading ? "refresh-btn--loading" : ""}`}
                onClick={handleManualRefresh}
                disabled={suggestLoading || !transcript.length}
              >
                {suggestLoading ? "⟳ Refreshing…" : "🔄 Refresh Now"}
              </button>
              <span className="auto-refresh-label">
                {nextRefreshIn !== null ? `auto in ${nextRefreshIn}s` : "start mic to enable"}
              </span>
            </div>

            <div className="suggestions-box">
              {batches.length === 0 ? (
                <div className="suggestions-empty">
                  <p className="empty-msg-title">No suggestions yet</p>
                  <p className="empty-msg-sub">
                    Start recording — 3 context-aware suggestions will appear after the first transcript chunk.
                  </p>
                </div>
              ) : (
                batches.map((batch, bi) => (
                  <div key={bi} className={`batch-block ${bi > 0 ? "faded" : ""}`}>
                    {bi === 0 && (
                      <div className="batch-header-latest">Latest · {batch.time}</div>
                    )}
                    {batch.items.map((s, i) => {
                      const meta = TYPE_META[s.type] ?? { label: s.type, color: "#6b7280" };
                      return (
                        <div key={i} className="suggestion-card"
                          style={{ "--type-color": meta.color }}
                          onClick={() => expandSuggestion(s)}
                          title="Click for detailed answer"
                        >
                          <div className="suggestion-type-pill">{meta.label}</div>
                          <div className="suggestion-preview">{s.preview}</div>
                          {s.detail && <div className="suggestion-detail">{s.detail}</div>}
                          <div className="suggestion-cta">Click for details →</div>
                        </div>
                      );
                    })}
                    {bi > 0 && (
                      <div className="batch-footer">Batch {batchCount - bi} · {batch.time}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* RIGHT: CHAT */}
        <div className="column">
          <div className="panel">
            <div className="panel-header">
              <h2>3. CHAT</h2>
              <span className={`status-badge ${isRecording ? "status-live" : ""}`}>
                {isRecording ? "● LIVE" : "SESSION-ONLY"}
              </span>
            </div>

            <div className="chat-inner">
              <div className="chat-scroll">
                {chat.length === 0 && (
                  <p className="empty-msg">Click a suggestion or type a question below.</p>
                )}
                {chat.map((c, i) => {
                  const meta = c.msgType ? (TYPE_META[c.msgType] ?? null) : null;
                  return (
                    <div key={i} className={`chat-message-block ${c.role}`}>
                      <div className="chat-label">
                        {c.role === "user" ? (
                          <>
                            YOU
                            {meta && (
                              <span className="chat-type-pill"
                                style={{ background: meta.color + "22", color: meta.color, border: `1px solid ${meta.color}44` }}>
                                {meta.label}
                              </span>
                            )}
                          </>
                        ) : "ASSISTANT"}
                        {c.timestamp && <span className="chat-ts">{c.timestamp}</span>}
                      </div>
                      <div className={`chat-bubble ${c.role === "user" ? "bubble-user" : "bubble-ai"}`}>
                      {c.role === "ai"
                       ? (() => {
                      const lines = c.text.split("\n").filter(l => l.trim());
                      const isBullets = lines.every(l => l.trim().startsWith("-"));
                      if (isBullets) {
                     return (
                       <ul className="chat-bullets">
                       {lines.map((l, i) => (
                       <li key={i}>{l.replace(/^\s*-\s*/, "")}</li>
                        ))}
                      </ul>
                     );
                     }
                    return <span dangerouslySetInnerHTML={{ __html: c.text.replace(/\n/g, "<br/>") }} />;
                     })()
                    : c.text
                    }
                    </div>
                    </div>
                  );
                })}

                {loading && (
                  <div className="chat-message-block ai">
                    <div className="chat-label">ASSISTANT</div>
                    <div className="chat-bubble bubble-ai thinking-bubble">
                      <span className="dot" /><span className="dot" /><span className="dot" />
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              <div className="chat-input-row">
                <input
                  className="chat-input"
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder="Ask anything about the meeting…"
                  disabled={loading}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && userInput.trim()) {
                      sendMessage(userInput);
                      setUserInput("");
                    }
                  }}
                />
                <button
                  className="chat-send-btn"
                  disabled={loading || !userInput.trim()}
                  onClick={() => { sendMessage(userInput); setUserInput(""); }}
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}