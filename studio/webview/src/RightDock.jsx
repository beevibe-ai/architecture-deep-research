import React, { useEffect, useRef, useState } from "react";
import ChatSidebar from "./ChatSidebar.jsx";
import IrJsonPanel from "./IrJsonPanel.jsx";
import PlanPanel from "./PlanPanel.jsx";
import NotesPanel from "./NotesPanel.jsx";

// The right-hand dock. Tabs over one panel: the design assistant, a notebook for
// requirements/ideas, the live IR (architecture.spec.json), and the generated
// plan.md. Each reads the same single source of truth (`spec`).
const TABS = [
  { id: "assistant", label: "Assistant" },
  { id: "notes", label: "Notes" },
  { id: "ir", label: "IR JSON" },
  { id: "plan", label: "Plan" },
];

const MIN_DOCK_WIDTH = 360;
const MAX_DOCK_WIDTH = 720;
const DEFAULT_DOCK_WIDTH = 440;
const DOCK_WIDTH_KEY = "adrStudio.dockWidth";
const DOCK_COLLAPSED_KEY = "adrStudio.dockCollapsed";

function clampWidth(value) {
  return Math.max(MIN_DOCK_WIDTH, Math.min(MAX_DOCK_WIDTH, value));
}

function initialWidth() {
  if (typeof window === "undefined") return DEFAULT_DOCK_WIDTH;
  const saved = Number(window.localStorage.getItem(DOCK_WIDTH_KEY));
  return Number.isFinite(saved) && saved > 0 ? clampWidth(saved) : DEFAULT_DOCK_WIDTH;
}

function initialCollapsed() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(DOCK_COLLAPSED_KEY) === "true";
}

export default function RightDock({
  spec,
  commit,
  messages,
  busy,
  onAsk,
  onSend,
  onSuggest,
  onPreviewRecommendation,
  onApplyRecommendation,
  violations,
  onWritePlan,
}) {
  const [tab, setTab] = useState("assistant");
  const [width, setWidth] = useState(initialWidth);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const dragRef = useRef(null);

  useEffect(() => {
    window.localStorage.setItem(DOCK_WIDTH_KEY, String(width));
  }, [width]);

  useEffect(() => {
    window.localStorage.setItem(DOCK_COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    const onMove = (event) => {
      if (!dragRef.current) return;
      const nextWidth = dragRef.current.startWidth + dragRef.current.startX - event.clientX;
      setWidth(clampWidth(nextWidth));
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  const sendFromNotes = (text) => {
    setTab("assistant");
    onSend(text);
  };

  const openTab = (id) => {
    setTab(id);
    setCollapsed(false);
  };

  const startResize = (event) => {
    if (collapsed) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  if (collapsed) {
    return (
      <aside className="dock dock-collapsed" aria-label="Collapsed right panel">
        <button className="dock-open" onClick={() => setCollapsed(false)} title="Open panel">
          Open
        </button>
        <div className="dock-rail-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`dock-rail-tab ${tab === t.id ? "active" : ""}`} onClick={() => openTab(t.id)} title={t.label}>
              {t.label.slice(0, 1)}
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="dock" style={{ width }}>
      <button className="dock-resizer" onPointerDown={startResize} title="Drag to resize panel" aria-label="Resize right panel" />
      <div className="dock-head">
        <div className="dock-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`dock-tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <button className="mini-btn ghost dock-hide" onClick={() => setCollapsed(true)} title="Collapse panel">
          Hide
        </button>
      </div>
      <div className="dock-body">
        {tab === "assistant" && (
          <ChatSidebar
            messages={messages}
            busy={busy}
            onAsk={onAsk}
            onSend={onSend}
            onSuggest={onSuggest}
            onPreviewRecommendation={onPreviewRecommendation}
            onApplyRecommendation={onApplyRecommendation}
            violations={violations}
          />
        )}
        {tab === "notes" && <NotesPanel spec={spec} commit={commit} busy={busy} onSend={sendFromNotes} onSuggest={onSuggest} />}
        {tab === "ir" && <IrJsonPanel spec={spec} />}
        {tab === "plan" && <PlanPanel spec={spec} onWritePlan={onWritePlan} />}
      </div>
    </aside>
  );
}
