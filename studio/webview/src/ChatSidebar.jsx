import React, { memo, useState, useRef, useEffect } from "react";
import MarkdownText from "./MarkdownText.jsx";

// The design assistant. Plain product chat — the user sketches what they want,
// gets expert discussion by default, and can preview/apply changes when needed.
// Violations surface here too so the conversation and lint stay in one place.
export default function ChatSidebar({
  messages,
  busy,
  onAsk,
  onSend,
  onSuggest,
  onPreviewRecommendation,
  onApplyRecommendation,
  violations,
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef(null);
  const starters = [
    "review the biggest architecture risk",
    "should this be event-driven?",
    "how should control and execution be separated?",
  ];

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  const ask = () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (onAsk) onAsk(text);
    else if (onSuggest) onSuggest(text);
    else onSend(text);
    setDraft("");
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft("");
  };

  const preview = () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (onSuggest) onSuggest(text);
    else onSend(text);
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
          <MessageRow
            key={i}
            message={m}
            busy={busy}
            onSend={onSend}
            onPreviewRecommendation={onPreviewRecommendation}
            onApplyRecommendation={onApplyRecommendation}
          />
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
          placeholder="Ask for architecture review, tradeoffs, or a change proposal..."
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
        />
        <div className="chat-actions">
          <button className="btn" onClick={ask} disabled={!draft.trim() || busy}>
            Ask Architect
          </button>
          <button className="mini-btn" onClick={preview} disabled={!draft.trim() || busy || !onSuggest} title="Generate concrete candidate diffs without changing the live canvas.">
            Preview change
          </button>
          <button className="mini-btn ghost" onClick={submit} disabled={!draft.trim() || busy} title="Edits the canvas immediately; blocked if it introduces new issues.">
            Apply direct
          </button>
        </div>
      </div>
    </aside>
  );
}

const MessageRow = memo(function MessageRow({
  message,
  busy,
  onSend,
  onPreviewRecommendation,
  onApplyRecommendation,
}) {
  const renderMarkdown = !message.streaming && (message.role === "assistant" || message.role === "system");
  return (
    <div className={`msg msg-${message.role} ${message.streaming ? "streaming" : ""}`}>
      {renderMarkdown ? (
        <MarkdownText text={message.text} />
      ) : (
        <div className="msg-text">{message.text}</div>
      )}
      {message.streaming && <span className="caret">▍</span>}
      {message.role === "assistant" && message.kind === "architect" && !message.streaming && (
        <div className="msg-actions">
          <button className="mini-btn" onClick={() => onPreviewRecommendation?.(message)} disabled={busy || !onPreviewRecommendation}>
            Preview recommendation
          </button>
          <button className="mini-btn ghost" onClick={() => onApplyRecommendation?.(message)} disabled={busy || !onApplyRecommendation}>
            Apply recommendation
          </button>
        </div>
      )}
      {message.role === "assistant" && message.limited && !message.streaming && (
        <div className="msg-actions">
          <button className="mini-btn" onClick={() => onSend?.("continue")} disabled={busy || !onSend}>
            Continue
          </button>
        </div>
      )}
    </div>
  );
});
