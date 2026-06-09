import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { generatePlan } from "../../shared/plan.mjs";

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
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code: ({ inline, className, children }) =>
              inline ? (
                <code className={className}>{children}</code>
              ) : (
                <pre className="plan-code">
                  <code className={className}>{children}</code>
                </pre>
              ),
          }}
        >
          {md}
        </ReactMarkdown>
      </div>
    </div>
  );
}
