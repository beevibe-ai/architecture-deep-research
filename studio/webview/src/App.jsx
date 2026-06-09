import React, { useEffect, useState, useCallback } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import Palette from "./Palette.jsx";
import Canvas from "./Canvas.jsx";
import ChatSidebar from "./ChatSidebar.jsx";
import { post, onMessage } from "./vscode.js";
import { emptySpec } from "../../shared/ir.mjs";
import { lint } from "../../shared/constraints.mjs";

export default function App() {
  const [spec, setSpec] = useState(emptySpec());
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  // Wire up the host bridge once, then announce we're ready for the spec.
  useEffect(() => {
    const off = onMessage((msg) => {
      switch (msg.type) {
        case "spec":
          setSpec(msg.spec);
          break;
        case "chatReply":
          setSpec(msg.spec);
          setMessages((m) => [...m, { role: "assistant", text: msg.text }]);
          setBusy(false);
          break;
        case "exported":
          flash(`Handoff written → ${msg.path}`);
          break;
        case "error":
          setMessages((m) => [...m, { role: "system", text: `⚠ ${msg.message}` }]);
          setBusy(false);
          break;
        default:
          break;
      }
    });
    post({ type: "ready" });
    return off;
  }, []);

  function flash(text) {
    setToast(text);
    // No timers in shared logic, but the UI can clear after a tick.
    setTimeout(() => setToast(null), 2600);
  }

  // Every committed canvas edit flows through here: update local state and
  // persist to disk via the host. Single write path.
  const commit = useCallback((nextSpec) => {
    setSpec(nextSpec);
    post({ type: "persist", spec: nextSpec });
  }, []);

  const sendChat = useCallback(
    (text) => {
      setMessages((m) => [...m, { role: "user", text }]);
      setBusy(true);
      post({ type: "chat", text, spec });
    },
    [spec]
  );

  const exportHandoff = useCallback(() => {
    post({ type: "export", spec });
  }, [spec]);

  const { violations } = lint(spec);

  return (
    <ReactFlowProvider>
      <div className="studio">
        <header className="topbar">
          <div className="title">{spec.decision?.title || "Untitled architecture"}</div>
          <div className="spacer" />
          <span className={`lint-badge ${violations.length ? "bad" : "ok"}`}>
            {violations.length ? `${violations.length} issue${violations.length > 1 ? "s" : ""}` : "clean"}
          </span>
          <button className="btn" onClick={exportHandoff}>
            Export handoff
          </button>
        </header>

        <div className="body">
          <Palette />
          <Canvas spec={spec} commit={commit} violations={violations} />
          <ChatSidebar
            messages={messages}
            busy={busy}
            onSend={sendChat}
            violations={violations}
          />
        </div>

        {toast && <div className="toast">{toast}</div>}
      </div>
    </ReactFlowProvider>
  );
}
