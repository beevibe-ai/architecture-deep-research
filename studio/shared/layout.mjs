// Auto-layout for editable diagrams. Dagre gives us deterministic graph order;
// the architecture view then groups top-level components into semantic layer
// bands so the canvas reads like an architecture map instead of a wiring board.
import dagre from "dagre";
import { LAYERS, layerForNode } from "./catalog.mjs";

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

const ARCH_NODE_GAP_X = 82;
const ARCH_NODE_GAP_Y = 44;
const ARCH_LAYER_GAP = 96;
const ARCH_MARGIN_X = 48;
const ARCH_MARGIN_Y = 44;
const ARCH_MAX_ROW_ITEMS = 5;

function layoutArchitecture(nodes, edges, direction = "TB") {
  layoutNestedContainers(nodes, edges, () => ({ w: 180, h: 80 }), direction);
  const topLevel = nodes.filter((n) => !n.parent);
  if (!topLevel.length) return;

  const topIds = new Set(topLevel.map((n) => n.id));
  const topEdges = edges.filter((e) => topIds.has(e.from) && topIds.has(e.to));
  const sizeOf = (n) => n.size || { w: 180, h: 80 };
  const rough = rankPositions(topLevel, topEdges, {
    direction,
    sizeOf,
    nodesep: 90,
    ranksep: 140,
  });
  const layers = orderedLayers(topLevel);
  const byLayer = new Map(layers.map((layer) => [layer, []]));
  for (const node of topLevel) {
    const layer = layerForNode(node);
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer).push(node);
  }

  const sortAxis = direction === "LR" ? "y" : "x";
  for (const layer of byLayer.keys()) {
    byLayer.get(layer).sort((a, b) =>
      (rough[a.id]?.[sortAxis] ?? 0) - (rough[b.id]?.[sortAxis] ?? 0) ||
      String(a.label || a.id).localeCompare(String(b.label || b.id))
    );
  }

  if (direction === "LR") layoutLayersLeftToRight(layers, byLayer, sizeOf);
  else layoutLayersTopToBottom(layers, byLayer, sizeOf);
}

function layoutNestedContainers(nodes, edges, leafSize, direction) {
  const childrenOf = new Map();
  for (const n of nodes) {
    const p = n.parent || null;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(n);
  }
  const sizeOf = (n) => n.size || leafSize(n);

  function layoutLevel(parentId) {
    const kids = childrenOf.get(parentId) || [];
    for (const k of kids) if (childrenOf.has(k.id)) k.size = layoutLevel(k.id);
    const ids = new Set(kids.map((k) => k.id));
    const innerEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const pos = rankPositions(kids, innerEdges, { direction, sizeOf });
    let maxX = 0, maxY = 0;
    for (const k of kids) {
      const p = pos[k.id] || { x: 0, y: 0 };
      k.position = { x: p.x + PAD, y: p.y + HEADER_Y };
      const s = sizeOf(k);
      maxX = Math.max(maxX, k.position.x + s.w);
      maxY = Math.max(maxY, k.position.y + s.h);
    }
    return { w: maxX + PAD, h: maxY + PAD };
  }

  for (const node of childrenOf.get(null) || []) {
    if (childrenOf.has(node.id)) node.size = layoutLevel(node.id);
  }
}

function orderedLayers(nodes) {
  const present = new Set(nodes.map((n) => layerForNode(n)));
  const known = LAYERS.map((l) => l.id).filter((id) => present.has(id));
  const extra = [...present].filter((id) => !known.includes(id)).sort();
  return [...known, ...extra];
}

function rowsFor(items, maxItems) {
  const rows = [];
  for (const item of items) {
    const row = rows[rows.length - 1];
    if (!row || row.length >= maxItems) rows.push([item]);
    else row.push(item);
  }
  return rows;
}

function layoutLayersTopToBottom(layers, byLayer, sizeOf) {
  let y = ARCH_MARGIN_Y;
  for (const layer of layers) {
    const nodes = byLayer.get(layer) || [];
    if (!nodes.length) continue;
    const measured = nodes.map((node) => ({ node, size: sizeOf(node) }));
    const maxItems = Math.min(ARCH_MAX_ROW_ITEMS, Math.max(1, Math.ceil(Math.sqrt(measured.length * 2))));
    const rows = rowsFor(measured, maxItems);
    for (const row of rows) {
      let x = ARCH_MARGIN_X;
      const rowH = Math.max(...row.map((item) => item.size.h));
      for (const item of row) {
        item.node.position = { x, y };
        x += item.size.w + ARCH_NODE_GAP_X;
      }
      y += rowH + ARCH_NODE_GAP_Y;
    }
    y += ARCH_LAYER_GAP - ARCH_NODE_GAP_Y;
  }
}

function layoutLayersLeftToRight(layers, byLayer, sizeOf) {
  let x = ARCH_MARGIN_X;
  for (const layer of layers) {
    const nodes = byLayer.get(layer) || [];
    if (!nodes.length) continue;
    const measured = nodes.map((node) => ({ node, size: sizeOf(node) }));
    const colW = Math.max(...measured.map((item) => item.size.w));
    let y = ARCH_MARGIN_Y;
    for (const item of measured) {
      item.node.position = { x, y };
      y += item.size.h + ARCH_NODE_GAP_Y;
    }
    x += colW + ARCH_LAYER_GAP + ARCH_NODE_GAP_X;
  }
}

// Apply auto-layout to one view, mutating node positions in place.
export function applyAutoLayout(spec, view, direction) {
  if (view === "architecture") {
    layoutArchitecture(spec.views.architecture.nodes, spec.views.architecture.edges, direction || "TB");
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
