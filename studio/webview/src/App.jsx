import React, { useEffect, useRef, useState, useCallback } from "react";
import ViewTabs from "./ViewTabs.jsx";
import ArchitectureView from "./views/ArchitectureView.jsx";
import DataModelView from "./views/DataModelView.jsx";
import FlowsView from "./views/FlowsView.jsx";
import RightDock from "./RightDock.jsx";
import { post, onMessage } from "./vscode.js";
import { emptySpec } from "../../shared/ir.mjs";
import { lint } from "../../shared/constraints.mjs";

export default function App() {
  const [spec, setSpec] = useState(emptySpec());
  const [activeView, setActiveView] = useState("architecture");
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  // Mirror `busy` into a ref so the (stable) commit callback can gate edits
  // while a stream is in flight without re-creating itself.
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Undo/redo history. Every immutable spec is a snapshot — undo/redo is just a
  // stack of them. Refs (not state) so the keyboard handler stays stable.
  const specRef = useRef(spec);
  useEffect(() => {
    specRef.current = spec;
  }, [spec]);
  const pastRef = useRef([]);
  const futureRef = useRef([]);
  const recordHistory = useCallback(() => {
    pastRef.current.push(specRef.current);
    if (pastRef.current.length > 50) pastRef.current.shift();
    futureRef.current = [];
  }, []);
  const restore = useCallback((next) => {
    setSpec(next);
    post({ type: "persist", spec: next });
  }, []);
  const undo = useCallback(() => {
    if (!pastRef.current.length) return;
    futureRef.current.push(specRef.current);
    restore(pastRef.current.pop());
  }, [restore]);
  const redo = useCallback(() => {
    if (!futureRef.current.length) return;
    pastRef.current.push(specRef.current);
    restore(futureRef.current.pop());
  }, [restore]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Wire up the host bridge once, then announce we're ready for the spec.
  useEffect(() => {
    const off = onMessage((msg) => {
      switch (msg.type) {
        case "spec":
          // Full load or external reload — reset history to avoid undoing into
          // a state that no longer matches disk.
          pastRef.current = [];
          futureRef.current = [];
          setSpec(msg.spec);
          break;
        case "externalReload":
          flash("Spec reloaded from disk");
          break;
        case "chatStart":
          // Open a streaming assistant bubble the tokens append into.
          setMessages((m) => [...m, { role: "assistant", text: "", streaming: true }]);
          break;
        case "chatToken":
          setMessages((m) => appendToLast(m, msg.text));
          break;
        case "specPatch":
          setSpec(msg.spec); // canvases animate mid-stream
          break;
        case "chatDone":
          setSpec(msg.spec);
          setMessages((m) => finalizeLast(m, msg.text));
          setBusy(false);
          break;
        case "exported":
          flash(`Handoff written → ${msg.path}`);
          break;
        case "planWritten":
          flash(`Plan written → ${msg.path}`);
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

  // Append a streamed token to the last (streaming) assistant message.
  function appendToLast(list, text) {
    if (!list.length) return list;
    const copy = list.slice();
    const last = copy[copy.length - 1];
    copy[copy.length - 1] = { ...last, text: (last.text || "") + text };
    return copy;
  }
  // Replace the streaming bubble's text with the final assistant text.
  function finalizeLast(list, text) {
    if (!list.length) return list;
    const copy = list.slice();
    const last = copy[copy.length - 1];
    copy[copy.length - 1] = { ...last, text: text || last.text || "Done.", streaming: false };
    return copy;
  }

  // Every committed canvas edit flows through here: update local state and
  // persist to disk via the host. Single write path. Edits are ignored while
  // the assistant is streaming, so a user drag can't race incoming specPatches.
  const commit = useCallback(
    (nextSpec) => {
      if (busyRef.current) return;
      recordHistory();
      setSpec(nextSpec);
      post({ type: "persist", spec: nextSpec });
    },
    [recordHistory]
  );

  const sendChat = useCallback(
    (text) => {
      recordHistory(); // one undo step reverts the whole assistant turn
      setMessages((m) => [...m, { role: "user", text }]);
      setBusy(true);
      post({ type: "chat", text, spec });
    },
    [spec, recordHistory]
  );

  const exportHandoff = useCallback(() => {
    post({ type: "export", spec });
  }, [spec]);

  const writePlan = useCallback(
    (markdown) => post({ type: "writePlan", spec, markdown }),
    [spec]
  );

  const { violations } = lint(spec);
  const counts = {
    architecture: spec.views.architecture.nodes.length,
    data_model: spec.views.data_model.entities.length,
    flows: spec.views.flows.length,
  };

  return (
    <div className="studio">
      <header className="topbar">
        <div className="title">{spec.decision?.title || "Untitled architecture"}</div>
        <div className="spacer" />
        <span className={`lint-badge ${violations.length ? "bad" : "ok"}`}>
          {violations.length ? `${violations.length} issue${violations.length > 1 ? "s" : ""}` : "clean"}
        </span>
        <button className="btn ghost" onClick={() => post({ type: "writePlan", spec })}>
          Write plan.md
        </button>
        <button className="btn" onClick={exportHandoff}>
          Export handoff
        </button>
      </header>

      <div className="body">
        <div className="view-col">
          <ViewTabs active={activeView} onChange={setActiveView} counts={counts} />
          <div className="view-stage">
            {activeView === "architecture" && <ArchitectureView spec={spec} commit={commit} violations={violations} />}
            {activeView === "data_model" && <DataModelView spec={spec} commit={commit} />}
            {activeView === "flows" && <FlowsView spec={spec} commit={commit} />}
          </div>
        </div>
        <RightDock
          spec={spec}
          messages={messages}
          busy={busy}
          onSend={sendChat}
          violations={violations}
          onWritePlan={writePlan}
        />
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
