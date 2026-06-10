// Auto-layout — the same engine Mermaid uses (dagre) so the editable React Flow
// canvas lays out as cleanly as a Mermaid diagram. Drives both the "Auto-arrange"
// button and the assistant's auto_layout tool. Deterministic (no Date/random).
import dagre from "dagre";

// Run dagre over a node/edge set and return id → top-left position.
function rankPositions(nodes, edges, { direction, sizeOf, nodesep = 45, ranksep = 80 }) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep, ranksep, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    const s = sizeOf(n);
    g.setNode(n.id, { width: s.w, height: s.h });
  }
  for (const e of edges) if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
  dagre.layout(g);
  const pos = {};
  for (const n of nodes) {
    const d = g.node(n.id);
    pos[n.id] = { x: Math.round(d.x - d.width / 2), y: Math.round(d.y - d.height / 2) };
  }
  return pos;
}

// Apply auto-layout to one view, mutating node positions in place.
export function applyAutoLayout(spec, view, direction) {
  if (view === "architecture") {
    const a = spec.views.architecture;
    const top = a.nodes.filter((n) => !n.parent); // children stay relative to their container
    const ids = new Set(top.map((n) => n.id));
    const edges = a.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const pos = rankPositions(top, edges, { direction: direction || "TB", sizeOf: () => ({ w: 180, h: 80 }) });
    for (const n of top) if (pos[n.id]) n.position = pos[n.id];
  } else if (view === "data_model") {
    const dm = spec.views.data_model;
    const pos = rankPositions(dm.entities, dm.relations, {
      direction: direction || "LR",
      sizeOf: (e) => ({ w: 180, h: 44 + (e.fields?.length || 0) * 22 }),
    });
    for (const e of dm.entities) if (pos[e.id]) e.position = pos[e.id];
  } else if (view === "flows") {
    for (const flow of spec.views.flows) {
      const pos = rankPositions(flow.nodes, flow.transitions, { direction: direction || "TB", sizeOf: () => ({ w: 130, h: 50 }) });
      for (const s of flow.nodes) if (pos[s.id]) s.position = pos[s.id];
    }
  } else if (view === "classes") {
    const cv = spec.views.classes;
    // Reverse inheritance edges so the base class ranks above its subclasses.
    const ranked = cv.edges.map((e) => (e.kind === "inherits" || e.kind === "implements" ? { from: e.to, to: e.from } : e));
    const pos = rankPositions(cv.nodes, ranked, {
      direction: direction || "TB",
      sizeOf: (c) => ({ w: 200, h: 50 + (c.members?.length || 0) * 20 }),
    });
    for (const c of cv.nodes) if (pos[c.id]) c.position = pos[c.id];
  } else if (view === "infra") {
    const inf = spec.views.infra;
    const top = inf.nodes.filter((n) => !n.parent);
    const ids = new Set(top.map((n) => n.id));
    const edges = inf.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const pos = rankPositions(top, edges, { direction: direction || "TB", sizeOf: () => ({ w: 200, h: 90 }) });
    for (const n of top) if (pos[n.id]) n.position = pos[n.id];
  }
  return spec;
}
