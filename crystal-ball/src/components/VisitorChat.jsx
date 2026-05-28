import { useState } from "react";

// Visitor asks a question, server replies as a continuation of the publisher's
// reasoning (stance-inheritance mode). Capsule is sent as system context.
export default function VisitorChat({ capsule }) {
  const [messages, setMessages] = useState([]); // {role, text}
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send() {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    setError("");
    const next = [...messages, { role: "user", text: q }];
    setMessages(next);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capsule,
          history: next,
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setMessages((m) => [...m, { role: "assistant", text: data.reply || "" }]);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function onKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="cb-chat">
      <div className="cb-chat-log">
        {messages.length === 0 && (
          <div className="cb-dim cb-chat-hint">
            Ask this capsule anything — it will answer as a continuation of the
            publisher's thinking, with the full session as context.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`cb-chat-bubble cb-${m.role}`}>
            <div className="cb-role">{m.role}</div>
            <div className="cb-text">{m.text}</div>
          </div>
        ))}
        {busy && <div className="cb-dim">thinking…</div>}
        {error && <div className="cb-fail-text">Error: {error}</div>}
      </div>
      <div className="cb-chat-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="Ask the crystal…  (Enter to send, Shift+Enter for newline)"
          rows={2}
        />
        <button onClick={send} disabled={busy || !input.trim()}>
          Ask
        </button>
      </div>
    </div>
  );
}
