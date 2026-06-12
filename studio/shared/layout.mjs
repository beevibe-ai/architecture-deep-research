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

// Hierarchical layout: lay out each container's direct children relative to the
// container (offset below its title), size every container to fit its children,
// then lay out the top level. Without this, nested nodes (a namespace's
// deployments, a runtime's internals) all stack at (0,0) and overlap into an
// unreadable pile. Container sizes are stored on `node.size` for the renderer.
const HEADER_Y = 40, PAD = 16;
function layoutHierarchy(nodes, edges, leafSize, direction) {
  const childrenOf = new Map();
  for (const n of nodes) {
    const p = n.parent || null;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(n);
  }
  const sizeOf = (n) => n.size || leafSize(n);

  function layoutLevel(parentId) {
    const kids = childrenOf.get(parentId) || [];
    for (const k of kids) if (childrenOf.has(k.id)) k.size = layoutLevel(k.id); // bottom-up
    const ids = new Set(kids.map((k) => k.id));
    const innerEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const pos = rankPositions(kids, innerEdges, { direction, sizeOf });
    const ox = parentId ? PAD : 0;
    const oy = parentId ? HEADER_Y : 0;
    let maxX = 0, maxY = 0;
    for (const k of kids) {
      const p = pos[k.id] || { x: 0, y: 0 };
      k.position = { x: p.x + ox, y: p.y + oy };
      const s = sizeOf(k);
      maxX = Math.max(maxX, k.position.x + s.w);
      maxY = Math.max(maxY, k.position.y + s.h);
    }
    return { w: maxX + PAD, h: maxY + PAD };
  }
  layoutLevel(null);
}

// Apply auto-layout to one view, mutating node positions in place.
export function applyAutoLayout(spec, view, direction) {
  if (view === "architecture") {
    layoutHierarchy(spec.views.architecture.nodes, spec.views.architecture.edges, () => ({ w: 180, h: 80 }), direction || "TB");
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
    layoutHierarchy(spec.views.infra.nodes, spec.views.infra.edges, () => ({ w: 200, h: 90 }), direction || "TB");
  }
  return spec;
}

function layoutNodes(spec, view) {
  if (view === "architecture") return spec.views.architecture.nodes;
  if (view === "infra") return spec.views.infra.nodes;
  if (view === "data_model") return spec.views.data_model.entities;
  if (view === "classes") return spec.views.classes.nodes;
  return [];
}

export function hasCollapsedLayout(nodes) {
  const topLevel = nodes.filter((n) => !n.parent);
  if (topLevel.length <= 1) return false;
  const counts = new Map();
  for (const n of topLevel) {
    const p = n.position || { x: 0, y: 0 };
    const x = Number.isFinite(p.x) ? Math.round(p.x) : 0;
    const y = Number.isFinite(p.y) ? Math.round(p.y) : 0;
    const key = `${x},${y}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const maxStack = Math.max(...counts.values());
  return maxStack === topLevel.length || (topLevel.length >= 3 && maxStack >= 3);
}

export function repairCollapsedLayouts(spec, views = ["architecture", "infra"]) {
  let changed = false;
  for (const view of views) {
    if (hasCollapsedLayout(layoutNodes(spec, view))) {
      applyAutoLayout(spec, view, view === "architecture" ? "TB" : undefined);
      changed = true;
    }
  }
  return changed;
}
