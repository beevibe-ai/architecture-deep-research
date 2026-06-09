import React, { useState, useRef, useEffect } from "react";

// The design assistant. Plain product chat — the user says what they want, the
// assistant edits the canvas. Violations surface here too so the conversation
// and the lint stay in one place.
export default function ChatSidebar({ messages, busy, onSend, violations }) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft("");
  };

  return (
    <aside className="chat">
      <div className="chat-head">Design assistant</div>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            Try: “add an API service backed by Postgres, with Redis in front.”
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            {m.text}
          </div>
        ))}
        {busy && <div className="msg msg-assistant typing">…</div>}
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
          placeholder="Describe a change…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="btn" onClick={submit} disabled={busy}>
          Send
        </button>
      </div>
    </aside>
  );
}
