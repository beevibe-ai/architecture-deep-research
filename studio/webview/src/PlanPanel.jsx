import React, { useMemo } from "react";
import { generatePlan } from "../../shared/plan.mjs";
import MarkdownText from "./MarkdownText.jsx";

// The generated plan.md, rendered live. The structure (tables, lists, Mermaid)
// is deterministic from the IR; Mermaid blocks render as fenced code here (the
// canvas IS the diagram) and become real diagrams wherever the .md is rendered
// downstream (GitHub, the adr HTML renderer). "Write plan.md" persists it.
export default function PlanPanel({ spec, onWritePlan }) {
  const md = useMemo(() => generatePlan(spec), [spec]);
  return (
    <div className="plan-panel">
      <div className="plan-actions">
        <button className="btn" onClick={() => onWritePlan(md)}>
          Write plan.md
        </button>
      </div>
      <div className="plan-md">
        <MarkdownText text={md} />
      </div>
    </div>
  );
}
