import React, { useEffect, useRef, useState, useCallback } from "react";
import ViewTabs from "./ViewTabs.jsx";
import ArchitectureView from "./views/ArchitectureView.jsx";
import DataModelView from "./views/DataModelView.jsx";
import FlowsView from "./views/FlowsView.jsx";
import InfrastructureView from "./views/InfrastructureView.jsx";
import ClassView from "./views/ClassView.jsx";
import SequenceView from "./views/SequenceView.jsx";
import RightDock from "./RightDock.jsx";
import OptionsModal from "./OptionsModal.jsx";
import DriftModal from "./DriftModal.jsx";
import { post, onMessage } from "./vscode.js";
import { emptySpec, applyMutation } from "../../shared/ir.mjs";
import { lint } from "../../shared/constraints.mjs";
import { CATALOG } from "../../shared/catalog.mjs";

export default function App() {
  const [spec, setSpec] = useState(emptySpec());
  const [catalog, setCatalog] = useState(CATALOG);
  const [activeView, setActiveView] = useState("architecture");
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [options, setOptions] = useState(null); // { status, count, progress, options }
  const [drift, setDrift] = useState(null); // { status, repo, report, actual, stream }
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
        case "catalog":
          if (Array.isArray(msg.catalog) && msg.catalog.length) setCatalog(msg.catalog);
          break;
        case "externalReload":
          flash("Spec reloaded from disk");
          break;
        case "optionsStart":
          setOptions({ status: "generating", count: msg.count, progress: null, options: [], idea: msg.idea || "" });
          break;
        case "optionsProgress":
          setOptions((o) => (o ? { ...o, progress: { index: msg.index, label: msg.label } } : o));
          break;
        case "options":
          setOptions({ status: "ready", options: msg.options, idea: msg.idea || "" });
          break;
        case "optionsError":
          setOptions(null);
          flash(msg.message);
          break;
        case "scanStart":
          setDrift({ status: "scanning", repo: msg.repo, stream: "" });
          break;
        case "scanToken":
          setDrift((d) => (d ? { ...d, stream: (d.stream || "") + msg.text } : d));
          break;
        case "driftReport":
          setDrift({ status: "ready", repo: msg.repo, report: msg.report, actual: msg.actual, full: msg.full });
          break;
        case "scanDone":
          // Discover mode: the host loaded the reverse-engineered system into the
          // canvas (a "spec" message). Just acknowledge and close any scan UI.
          setDrift(null);
          flash(`Reverse-engineered ${msg.count} component${msg.count === 1 ? "" : "s"} from ${msg.repo}`);
          break;
        case "scanError":
          setDrift(null);
          flash(msg.message);
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
        case "manifestsWritten":
          flash(msg.count ? `Manifests written → ${msg.dir} (${msg.count} files)` : "No manifests to write yet");
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

  const suggestOptions = useCallback(
    (idea) => {
      const text = idea.trim();
      if (!text) return;
      setMessages((m) => [...m, { role: "user", text: `Explore: ${text}` }]);
      post({ type: "generateOptions", spec, idea: text });
    },
    [spec]
  );

  const exportHandoff = useCallback(() => {
    post({ type: "export", spec });
  }, [spec]);

  const writePlan = useCallback(
    (markdown) => post({ type: "writePlan", spec, markdown }),
    [spec]
  );

  // Load a generated candidate: replace the architecture, drop now-stale arch links.
  const useOption = useCallback(
    (opt) => {
      const next = {
        ...spec,
        views: { ...spec.views, architecture: opt.architecture },
        notes: opt.notes || spec.notes,
        cross_refs: (spec.cross_refs || []).filter((x) => x.from.view !== "architecture" && x.to.view !== "architecture"),
      };
      commit(next);
      setOptions(null);
      flash(`Loaded the “${opt.label}” design`);
    },
    [spec, commit]
  );

  // Reconcile drift: pull a real component into the design, fix a tech mismatch,
  // or drop a box the code never built. Each edit flows through the normal commit
  // path (undoable, persisted).
  const addFromCode = useCallback(
    (d) => {
      const note = d.evidence?.length ? `In code: ${d.evidence.join(", ")}` : "";
      commit(applyMutation(spec, { op: "add_node", view: "architecture", type: d.type, label: d.label, tech: d.tech, notes: note }));
      flash(`Added “${d.label}” from the code`);
    },
    [spec, commit]
  );
  const fixTech = useCallback(
    (d) => {
      commit(applyMutation(spec, { op: "update_node", view: "architecture", id: d.id, tech: d.actual_tech }));
      flash(`${d.label} → ${d.actual_tech}`);
    },
    [spec, commit]
  );
  const removePhantom = useCallback(
    (d) => {
      commit(applyMutation(spec, { op: "remove_node", view: "architecture", ref: d.id }));
      flash(`Removed “${d.label}”`);
    },
    [spec, commit]
  );
  // Replace the whole design with the system reverse-engineered from the repo.
  const loadActual = useCallback(
    (full) => {
      if (full) commit(full);
      setDrift(null);
      flash("Loaded the real system from the repo");
    },
    [commit]
  );

  // Per-node drift status for canvas coloring, derived from the latest report.
  const driftStatus = {};
  if (drift?.report) {
    for (const m of drift.report.designed_not_in_code) driftStatus[m.id] = "phantom";
    for (const m of drift.report.tech_mismatch) driftStatus[m.id] = "mismatch";
  }

  const { violations } = lint(spec);
  const counts = {
    architecture: spec.views.architecture.nodes.length,
    data_model: spec.views.data_model.entities.length,
    flows: spec.views.flows.length,
    infra: spec.views.infra.nodes.length,
    classes: spec.views.classes.nodes.length,
    sequences: spec.views.sequences.length,
  };

  return (
    <div className="studio">
      <header className="topbar">
        <div className="title">{spec.decision?.title || "Untitled architecture"}</div>
        <div className="spacer" />
        <span className={`lint-badge ${violations.length ? "bad" : "ok"}`}>
          {violations.length ? `${violations.length} issue${violations.length > 1 ? "s" : ""}` : "clean"}
        </span>
        <button className="btn" onClick={() => post({ type: "scanRepo", spec })} title="Infer the real architecture from the repo and show drift">
          Scan repo
        </button>
        <button className="btn" onClick={() => post({ type: "generateOptions", spec })}>
          Generate options
        </button>
        <button className="btn ghost" onClick={() => post({ type: "newDesign" })}>
          New
        </button>
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
            {activeView === "architecture" && <ArchitectureView spec={spec} commit={commit} catalog={catalog} driftStatus={driftStatus} />}
            {activeView === "data_model" && <DataModelView spec={spec} commit={commit} />}
            {activeView === "flows" && <FlowsView spec={spec} commit={commit} />}
            {activeView === "infra" && <InfrastructureView spec={spec} commit={commit} />}
            {activeView === "classes" && <ClassView spec={spec} commit={commit} />}
            {activeView === "sequences" && <SequenceView spec={spec} commit={commit} />}
          </div>
        </div>
        <RightDock
          spec={spec}
          commit={commit}
          messages={messages}
          busy={busy}
          onSend={sendChat}
          onSuggest={suggestOptions}
          violations={violations}
          onWritePlan={writePlan}
        />
      </div>

      {toast && <div className="toast">{toast}</div>}
      <OptionsModal state={options} onUse={useOption} onClose={() => setOptions(null)} />
      <DriftModal state={drift} onAdd={addFromCode} onFixTech={fixTech} onRemove={removePhantom} onLoadActual={loadActual} onClose={() => setDrift(null)} />
    </div>
  );
}
