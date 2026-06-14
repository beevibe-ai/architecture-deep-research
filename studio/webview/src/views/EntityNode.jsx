import React from "react";
import { Handle, Position } from "@xyflow/react";

// A data-model entity rendered as a table: name header + typed field rows with
// PK/FK badges. Ringed red when it violates a constraint (e.g. no primary key).
export default function EntityNode({ data, selected }) {
  const { entity, bad } = data;
  return (
    <div className={`entity-node ${bad ? "bad" : ""} ${selected ? "sel" : ""}`}>
      <Handle type="target" position={Position.Left} className="arch-handle" />
      <div className="entity-head">{entity.name}</div>
      <div className="entity-fields">
        {entity.fields.length === 0 && <div className="efield empty">no fields</div>}
        {entity.fields.map((f) => (
          <div className="efield" key={f.id}>
            <span className="ef-name">{f.name}</span>
            <span className="ef-type">{f.type}</span>
            {f.pk ? <span className="ef-badge pk">PK</span> : f.fk ? <span className="ef-badge fk">FK</span> : null}
          </div>
        ))}
      </div>
      <Handle type="source" position={Position.Right} className="arch-handle" />
    </div>
  );
}
