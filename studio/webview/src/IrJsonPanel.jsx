import React from "react";

// Live, read-only view of the IR exactly as it persists to architecture.spec.json.
// Read-only for now; editable-with-validation is a later add. Updates on every
// canvas or assistant edit because it derives straight from `spec`.
export default function IrJsonPanel({ spec }) {
  return (
    <div className="ir-panel">
      <pre className="ir-json">{JSON.stringify(spec, null, 2)}</pre>
    </div>
  );
}
