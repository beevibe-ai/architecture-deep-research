import React from "react";
import { Handle, Position } from "@xyflow/react";

// A flowchart step. Shape signals the type: start/end are pills, process is a
// rectangle, decision carries a diamond accent. Ringed red on violation
// (orphaned step, decision with one branch, …).
export default function FlowNode({ data, selected }) {
  const { step, bad } = data;
  return (
    <div className={`flow-step fs-${step.type} ${bad ? "bad" : ""} ${selected ? "sel" : ""}`}>
      {step.type !== "start" && <Handle type="target" position={Position.Top} className="arch-handle" />}
      <span className="fs-label">{step.label}</span>
      {step.type !== "end" && <Handle type="source" position={Position.Bottom} className="arch-handle" />}
    </div>
  );
}
