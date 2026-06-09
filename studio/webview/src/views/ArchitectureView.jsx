import React from "react";
import { ReactFlowProvider } from "@xyflow/react";
import Palette from "../Palette.jsx";
import Canvas from "../Canvas.jsx";

// The architecture view: component palette + the React Flow canvas, in its own
// provider so it doesn't share fit/zoom state with the other views.
export default function ArchitectureView({ spec, commit, violations }) {
  return (
    <ReactFlowProvider>
      <div className="view-area">
        <Palette />
        <Canvas spec={spec} commit={commit} violations={violations} />
      </div>
    </ReactFlowProvider>
  );
}
