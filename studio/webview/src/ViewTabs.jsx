import React from "react";

// Switches the canvas between the three diagram types. Each view owns its own
// React Flow instance, palette, and per-view lint; they all read and write the
// same single spec.
const VIEW_TABS = [
  { id: "architecture", label: "Architecture" },
  { id: "data_model", label: "Data Model" },
  { id: "flows", label: "Flows" },
  { id: "infra", label: "Infrastructure" },
];

export default function ViewTabs({ active, onChange, counts }) {
  return (
    <div className="view-tabs">
      {VIEW_TABS.map((t) => (
        <button
          key={t.id}
          className={`view-tab ${active === t.id ? "active" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {counts && counts[t.id] ? <span className="view-count">{counts[t.id]}</span> : null}
        </button>
      ))}
    </div>
  );
}
