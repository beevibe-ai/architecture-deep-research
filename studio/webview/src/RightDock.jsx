import React, { useState } from "react";
import ChatSidebar from "./ChatSidebar.jsx";
import IrJsonPanel from "./IrJsonPanel.jsx";
import PlanPanel from "./PlanPanel.jsx";

// The right-hand dock. Three tabs over one panel: the design assistant, the
// live IR (architecture.spec.json), and the generated plan.md. Each reads the
// same single source of truth (`spec`).
const TABS = [
  { id: "assistant", label: "Assistant" },
  { id: "ir", label: "IR JSON" },
  { id: "plan", label: "Plan" },
];

export default function RightDock({ spec, messages, busy, onSend, violations, onWritePlan }) {
  const [tab, setTab] = useState("assistant");
  return (
    <aside className="dock">
      <div className="dock-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`dock-tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="dock-body">
        {tab === "assistant" && (
          <ChatSidebar messages={messages} busy={busy} onSend={onSend} violations={violations} />
        )}
        {tab === "ir" && <IrJsonPanel spec={spec} />}
        {tab === "plan" && <PlanPanel spec={spec} onWritePlan={onWritePlan} />}
      </div>
    </aside>
  );
}
