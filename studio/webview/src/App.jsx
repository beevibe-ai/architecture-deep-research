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
import { summarizeSpecChange } from "../../shared/change-diff.mjs";

function violationKey(v) {
  return [v.constraintId, v.view, v.nodeId || "", v.edgeId || "", v.message].join("|");
}

function addedViolations(beforeSpec, nextSpec) {
  const before = new Set(lint(beforeSpec).violations.map(violationKey));
  return lint(nextSpec).violations.filter((v) => !before.has(violationKey(v)));
}

export default function App() {
  const [spec, setSpec] = useState(emptySpec());
  const [catalog, setCatalog] = useState(CATALOG);
  const [activeView, setActiveView] = useState("architecture");
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [saveState, setSaveState] = useState("saved");
  const [, setHistoryVersion] = useState(0);
  const [options, setOptions] = useState(null); // { status, count, progress, options }
  const [drift, setDrift] = useState(null); // { status, repo, report, actual, stream }
  const [infraCluster, setInfraCluster] = useState({ statusById: {}, summary: null, busy: null, profile: "minikube" });
  const [lastChange, setLastChange] = useState(null);
  const pendingTurnRef = useRef(null);
  const lastLimitedTurnRef = useRef(null);
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
    setHistoryVersion((v) => v + 1);
  }, []);
  const persistSpec = useCallback((next) => {
    setSaveState("saving");
    post({ type: "persist", spec: next });
  }, []);
  const rememberChange = useCallback((before, after, source) => {
    const change = summarizeSpecChange(before, after, source);
    if (change.total) setLastChange(change);
  }, []);
  const restore = useCallback((next, source = "History restore") => {
    rememberChange(specRef.current, next, source);
    setSpec(next);
    persistSpec(next);
  }, [persistSpec, rememberChange]);
  const undo = useCallback(() => {
    if (busyRef.current || !pastRef.current.length) return;
    futureRef.current.push(specRef.current);
    const next = pastRef.current.pop();
    setHistoryVersion((v) => v + 1);
    restore(next, "Undo");
  }, [restore]);
  const redo = useCallback(() => {
    if (busyRef.current || !futureRef.current.length) return;
    pastRef.current.push(specRef.current);
    const next = futureRef.current.pop();
    setHistoryVersion((v) => v + 1);
    restore(next, "Redo");
  }, [restore]);

  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName;
      const editingText = e.target?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (editingText) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
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
          setHistoryVersion((v) => v + 1);
          setSaveState("saved");
          setLastChange(null);
          setSpec(msg.spec);
          break;
        case "saved":
          setSaveState("saved");
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
          if (msg.message) flash(msg.message);
          break;
        case "scanDone":
          // Discover mode: the host loaded the reverse-engineered system into the
          // canvas (a "spec" message). Just acknowledge and close any scan UI.
          setDrift(null);
          flash(msg.message || `Reverse-engineered ${msg.count} component${msg.count === 1 ? "" : "s"} from ${msg.repo}`);
          break;
        case "scanError":
          setDrift(null);
          flash(msg.message);
          break;
        case "chatStart":
          // Open a streaming assistant bubble the tokens append into.
          setMessages((m) => [...m, { role: "assistant", text: "", streaming: true, ...(pendingTurnRef.current || {}) }]);
          break;
        case "chatToken":
          setMessages((m) => appendToLast(m, msg.text));
          break;
        case "specPatch":
          setSpec(msg.spec); // canvases animate mid-stream
          break;
        case "chatDone":
          if (pendingTurnRef.current?.kind === "direct" && pendingTurnRef.current.beforeSpec) {
            rememberChange(pendingTurnRef.current.beforeSpec, msg.spec, "Assistant suggestion");
          }
          setSpec(msg.spec);
          if (msg.limited && pendingTurnRef.current?.kind === "direct") {
            lastLimitedTurnRef.current = {
              sourceText: pendingTurnRef.current.sourceText || "",
              statusText: msg.text || "",
            };
          } else if (!msg.limited) {
            lastLimitedTurnRef.current = null;
          }
          setMessages((m) => finalizeLast(m, msg.text, { limited: !!msg.limited }));
          setBusy(false);
          setSaveState("saved");
          pendingTurnRef.current = null;
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
        case "infraOpStart":
          setInfraCluster((c) => ({ ...c, busy: msg.op, lastError: null }));
          break;
        case "infraOpDone":
          setInfraCluster((c) => ({ ...c, busy: null, dir: msg.dir, namespace: msg.namespace, lastMessage: msg.message }));
          flash(msg.message || `${msg.op} complete`);
          break;
        case "infraStatus":
          setInfraCluster((c) => ({
            ...c,
            busy: null,
            statusById: msg.statusById || {},
            summary: msg.summary || null,
            profile: msg.profile || c.profile || "minikube",
            context: msg.context,
            namespace: msg.namespace,
            dir: msg.dir || c.dir,
            lastMessage: msg.message,
            lastError: null,
          }));
          flash(msg.message || `Cluster status refreshed for ${msg.namespace || "default"}`);
          break;
        case "infraOpError":
          setInfraCluster((c) => ({ ...c, busy: null, lastError: msg.message }));
          flash(msg.message);
          break;
        case "error":
          setMessages((m) => [...m, { role: "system", text: `⚠ ${msg.message}` }]);
          setBusy(false);
          pendingTurnRef.current = null;
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
  function finalizeLast(list, text, patch = {}) {
    if (!list.length) return list;
    const copy = list.slice();
    const last = copy[copy.length - 1];
    copy[copy.length - 1] = { ...last, ...patch, text: text || last.text || "Done.", streaming: false };
    return copy;
  }

  // Every committed canvas edit flows through here: update local state and
  // persist to disk via the host. Single write path. Edits are ignored while
  // the assistant is streaming, so a user drag can't race incoming specPatches.
  const commit = useCallback(
    (nextSpec, source = "Canvas edit") => {
      if (busyRef.current) return;
      const beforeSpec = specRef.current;
      recordHistory();
      rememberChange(beforeSpec, nextSpec, source);
      setSpec(nextSpec);
      persistSpec(nextSpec);
    },
    [persistSpec, recordHistory, rememberChange]
  );

  const sendChat = useCallback(
    (text) => {
      const rawText = text.trim();
      const continuation = /^(continue|继续)$/i.test(rawText) ? lastLimitedTurnRef.current : null;
      const prompt = continuation?.sourceText
        ? [
            "Continue the previous architecture edit request from the current canvas.",
            "Do not restart the design or duplicate components that were already added.",
            "Prefer the remaining smallest safe edits, then run the constraint check and stop.",
            `Original request:\n${continuation.sourceText}`,
            continuation.statusText ? `Previous status:\n${continuation.statusText}` : "",
          ].filter(Boolean).join("\n\n")
        : rawText;
      const beforeSpec = specRef.current;
      recordHistory(); // one undo step reverts the whole assistant turn
      setMessages((m) => [...m, { role: "user", text: rawText }]);
      setBusy(true);
      pendingTurnRef.current = { kind: "direct", sourceText: continuation?.sourceText || rawText, beforeSpec };
      post({ type: "chat", text: prompt, spec: beforeSpec });
    },
    [recordHistory]
  );

  const askArchitect = useCallback(
    (text) => {
      const question = text.trim();
      if (!question) return;
      setMessages((m) => [...m, { role: "user", text: question }]);
      setBusy(true);
      pendingTurnRef.current = { kind: "architect", sourceText: question };
      post({ type: "architectReview", text: question, spec });
    },
    [spec]
  );

  const suggestOptions = useCallback(
    (request) => {
      const text = (typeof request === "string" ? request : request?.idea || "").trim();
      const context = (typeof request === "string" ? "" : request?.context || "").trim();
      if (!text) return;
      setMessages((m) => [...m, { role: "user", text: `Explore: ${text}` }]);
      post({ type: "generateOptions", spec, idea: text, context });
    },
    [spec]
  );

  const previewRecommendation = useCallback(
    (review) => {
      const source = (review.sourceText || "the current architecture question").trim();
      const text = (review.text || "").trim();
      suggestOptions({
        idea: `Turn the architect recommendation into a safe architecture change: ${source}`,
        context: [
          "Use the architect review below as the design brief.",
          "Do not blindly apply every bullet. Preserve the current diagram unless the recommendation clearly requires a change.",
          "Prefer the smallest diff that makes the recommendation concrete.",
          `Architect review:\n${text}`,
        ].join("\n\n"),
      });
    },
    [suggestOptions]
  );

  const applyRecommendation = useCallback(
    (review) => {
      const source = (review.sourceText || "the current architecture question").trim();
      const text = (review.text || "").trim();
      sendChat([
        `Apply the smallest safe architecture change implied by this architect review.`,
        `Original request: ${source}`,
        "Keep existing components where possible, avoid duplicates, and stop if the change would introduce new issues.",
        `Architect review:\n${text}`,
      ].join("\n\n"));
    },
    [sendChat]
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
      const newIssues = addedViolations(spec, next);
      if (newIssues.length) {
        const sample = newIssues.slice(0, 2).map((v) => v.message).join(" ");
        flash(`Suggestion blocked: ${newIssues.length} new issue${newIssues.length === 1 ? "" : "s"}`);
        setMessages((m) => [...m, { role: "system", text: `Suggestion not applied because it introduces ${newIssues.length} new issue${newIssues.length === 1 ? "" : "s"}. ${sample}` }]);
        return;
      }
      commit(next, `Loaded ${opt.label} design`);
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
      commit(applyMutation(spec, { op: "add_node", view: "architecture", type: d.type, label: d.label, tech: d.tech, notes: note }), "Added code component");
      flash(`Added “${d.label}” from the code`);
    },
    [spec, commit]
  );
  const fixTech = useCallback(
    (d) => {
      commit(applyMutation(spec, { op: "update_node", view: "architecture", id: d.id, tech: d.actual_tech }), "Fixed code drift");
      flash(`${d.label} → ${d.actual_tech}`);
    },
    [spec, commit]
  );
  const removePhantom = useCallback(
    (d) => {
      commit(applyMutation(spec, { op: "remove_node", view: "architecture", ref: d.id }), "Removed phantom component");
      flash(`Removed “${d.label}”`);
    },
    [spec, commit]
  );
  // Replace the whole design with the system reverse-engineered from the repo.
  const loadActual = useCallback(
    (full) => {
      if (full) commit(full, "Loaded real system from repo");
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
  const canUndo = !busy && pastRef.current.length > 0;
  const canRedo = !busy && futureRef.current.length > 0;
  const saveLabel = saveState === "saving" ? "Saving" : "Saved";
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
        <div className="edit-actions" aria-label="Edit history">
          <button className="mini-btn edit-btn" onClick={undo} disabled={!canUndo} title="Undo canvas edit (Cmd/Ctrl+Z)">
            Undo
          </button>
          <button className="mini-btn edit-btn" onClick={redo} disabled={!canRedo} title="Redo canvas edit (Cmd/Ctrl+Y or Cmd/Ctrl+Shift+Z)">
            Redo
          </button>
        </div>
        <span className={`save-badge ${saveState}`} title="Architecture spec autosaves after each edit">
          {saveLabel}
        </span>
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
            {activeView === "architecture" && <ArchitectureView spec={spec} commit={commit} catalog={catalog} driftStatus={driftStatus} changeHighlights={lastChange?.byView?.architecture} onSuggest={suggestOptions} />}
            {activeView === "data_model" && <DataModelView spec={spec} commit={commit} />}
            {activeView === "flows" && <FlowsView spec={spec} commit={commit} />}
            {activeView === "infra" && <InfrastructureView spec={spec} commit={commit} cluster={infraCluster} />}
            {activeView === "classes" && <ClassView spec={spec} commit={commit} />}
            {activeView === "sequences" && <SequenceView spec={spec} commit={commit} />}
          </div>
        </div>
        <RightDock
          spec={spec}
          commit={commit}
          messages={messages}
          busy={busy}
          onAsk={askArchitect}
          onSend={sendChat}
          onSuggest={suggestOptions}
          onPreviewRecommendation={previewRecommendation}
          onApplyRecommendation={applyRecommendation}
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
