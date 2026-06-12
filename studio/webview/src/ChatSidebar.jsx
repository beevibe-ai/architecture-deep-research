import React, { useState, useRef, useEffect } from "react";

// The design assistant. Plain product chat — the user says what they want, the
// assistant edits the canvas. Violations surface here too so the conversation
// and the lint stay in one place.
export default function ChatSidebar({ messages, busy, onSend, onSuggest, violations }) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef(null);
  const starters = [
    "make this event-driven",
    "add human review",
    "separate control and execution",
  ];

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft("");
  };

  const suggest = () => {
    const text = draft.trim();
    if (!text || busy || !onSuggest) return;
    onSuggest(text);
    setDraft("");
  };

  return (
    <aside className="chat">
      <div className="chat-head">Design assistant</div>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            {starters.map((text) => (
              <button className="idea-chip" key={text} onClick={() => setDraft(text)}>
                {text}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role} ${m.streaming ? "streaming" : ""}`}>
            {m.text}
            {m.streaming && <span className="caret">▍</span>}
          </div>
        ))}
        {busy && !messages[messages.length - 1]?.streaming && (
          <div className="msg msg-assistant typing">…</div>
        )}
      </div>

      {violations.length > 0 && (
        <div className="violations">
          {violations.map((v, i) => (
            <div key={i} className="violation">
              {v.message}
            </div>
          ))}
        </div>
      )}

      <div className="chat-input">
        <textarea
          rows={2}
          value={draft}
          placeholder="Sketch an idea or architecture change..."
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="chat-actions">
          <button className="mini-btn" onClick={suggest} disabled={!draft.trim() || busy || !onSuggest}>
            Suggest
          </button>
          <button className="btn" onClick={submit} disabled={!draft.trim() || busy}>
            Apply
          </button>
        </div>
      </div>
    </aside>
  );
}
