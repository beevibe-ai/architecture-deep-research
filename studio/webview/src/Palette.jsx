import React from "react";
import { NODE_KINDS } from "../../shared/ir.mjs";

// Drag source. Each chip carries its node kind; the canvas reads it on drop and
// places a real component there. This is the "drag a component in" half of the
// authoring loop — the chat assistant is the other half, both hitting the same
// applyMutation path.
export default function Palette() {
  return (
    <aside className="palette">
      <div className="palette-head">Components</div>
      {NODE_KINDS.map((k) => (
        <div
          key={k.kind}
          className={`chip chip-${k.kind}`}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("application/adr-kind", k.kind);
            e.dataTransfer.effectAllowed = "move";
          }}
        >
          <span className={`dot dot-${k.kind}`} />
          {k.label}
        </div>
      ))}
      <div className="palette-hint">Drag onto the canvas, or ask the assistant →</div>
    </aside>
  );
}
