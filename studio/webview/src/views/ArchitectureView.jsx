import React from "react";
import { ReactFlowProvider } from "@xyflow/react";
import CatalogPalette from "./CatalogPalette.jsx";
import Canvas from "../Canvas.jsx";

// The architecture view: catalog palette + the swimlane canvas, in its own
// provider so it doesn't share fit/zoom state with the other views.
export default function ArchitectureView({ spec, commit, catalog, driftStatus, onSuggest }) {
  return (
    <ReactFlowProvider>
      <div className="view-area">
        <CatalogPalette catalog={catalog} />
        <Canvas spec={spec} commit={commit} catalog={catalog} driftStatus={driftStatus} onSuggest={onSuggest} />
      </div>
    </ReactFlowProvider>
  );
}
