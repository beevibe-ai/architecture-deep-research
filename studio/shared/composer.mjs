import { getType, layerForNode } from "./catalog.mjs";

const ZONES = [
  { id: "access", label: "Clients / Access", layers: ["clients"], color: "#ffb9d5" },
  { id: "control", label: "Control / Orchestration", layers: ["orchestration"], color: "#c8a7ff" },
  { id: "capabilities", label: "Capabilities / Services", layers: ["capabilities"], color: "#7fd7ff" },
  { id: "tools", label: "Tools / Execution", layers: ["tools"], color: "#7fd7ff" },
  { id: "knowledge", label: "Memory / Knowledge", layers: ["memory", "knowledge"], color: "#9ee3c6" },
  { id: "models", label: "Models / External AI", layers: ["model"], color: "#ffb9d5" },
  { id: "ops", label: "Ops / External", layers: ["infrastructure", "external"], color: "#ffd7a3" },
];

const ZONE_BY_LAYER = new Map(ZONES.flatMap((z) => z.layers.map((l) => [l, z.id])));
const ZONE_BY_ID = new Map(ZONES.map((z) => [z.id, z]));

const CARD_W = 190;
const CARD_H = 72;
const GROUP_MIN_W = 320;
const GROUP_HEADER = 56;
const GROUP_PAD_X = 24;
const GROUP_PAD_BOTTOM = 24;
const CHILD_GAP_X = 28;
const CHILD_GAP_Y = 22;
const ZONE_X = 68;
const ZONE_PAD_X = 58;
const ZONE_PAD_TOP = 48;
const ZONE_PAD_BOTTOM = 34;
const ZONE_GAP_Y = 18;
const ITEM_GAP_X = 42;
const ITEM_GAP_Y = 30;

function zoneIdForNode(node) {
  return ZONE_BY_LAYER.get(layerForNode(node)) || "capabilities";
}

function isContainer(node) {
  return !!getType(node.type)?.container;
}

function graphScore(node, edges) {
  return edges.reduce((score, e) => score + (e.from === node.id || e.to === node.id ? 1 : 0), 0);
}

function stableNodeSort(edges) {
  return (a, b) => {
    const order = domainOrder(a) - domainOrder(b);
    if (order) return order;
    const za = zoneIdForNode(a);
    const zb = zoneIdForNode(b);
    if (za !== zb) return ZONES.findIndex((z) => z.id === za) - ZONES.findIndex((z) => z.id === zb);
    const sa = graphScore(a, edges);
    const sb = graphScore(b, edges);
    if (sa !== sb) return sb - sa;
    return String(a.label || a.id).localeCompare(String(b.label || b.id));
  };
}

function domainOrder(node) {
  const label = String(node.label || "").toLowerCase();
  const type = String(node.type || "");
  const order = [
    ["client", /\b(web|client|ui|frontend)\b/],
    ["gateway", /\b(gateway|edge)\b/],
    ["service", /\b(api|service)\b/],
    ["agent_runtime", /\bruntime\b/],
    ["daemon", /\bdaemon\b/],
    ["scheduler", /\bscheduler\b/],
    ["executor", /\bexecutor\b/],
    ["sandbox", /\bsandbox\b/],
    ["mcp_server", /\bmcp\b/],
    ["event_queue", /\b(queue|event|bus)\b/],
    ["relational_db", /\b(postgres|database|db)\b/],
    ["vector_db", /\b(vector|memory)\b/],
    ["llm_provider", /\b(llm|model|openai|anthropic)\b/],
  ];
  const idx = order.findIndex(([t, re]) => type === t || re.test(label));
  return idx === -1 ? 999 : idx;
}

function cardSize(node) {
  const labelLen = String(node.label || "").length;
  return { w: labelLen > 22 ? 220 : CARD_W, h: CARD_H };
}

function rowsFor(items, maxColumns) {
  const rows = [];
  for (const item of items) {
    const row = rows[rows.length - 1];
    if (!row || row.length >= maxColumns) rows.push([item]);
    else row.push(item);
  }
  return rows;
}

function rowWidth(row) {
  return row.reduce((sum, item, i) => sum + item.size.w + (i ? ITEM_GAP_X : 0), 0);
}

function layoutChildren(parent, children, nodeLayouts, edges) {
  const sorted = [...children].sort(stableNodeSort(edges));
  const measured = sorted.map((n) => ({ node: n, size: cardSize(n) }));
  const maxColumns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(measured.length || 1))));
  const rows = rowsFor(measured, maxColumns);
  const innerWidth = Math.max(
    GROUP_MIN_W - GROUP_PAD_X * 2,
    ...rows.map((row) => row.reduce((sum, item, i) => sum + item.size.w + (i ? CHILD_GAP_X : 0), 0)),
    CARD_W
  );
  let y = GROUP_HEADER;
  for (const row of rows) {
    const w = row.reduce((sum, item, i) => sum + item.size.w + (i ? CHILD_GAP_X : 0), 0);
    let x = GROUP_PAD_X + Math.round((innerWidth - w) / 2);
    const h = Math.max(...row.map((item) => item.size.h), CARD_H);
    for (const item of row) {
      nodeLayouts.set(item.node.id, {
        position: { x, y: y + Math.round((h - item.size.h) / 2) },
        size: item.size,
        role: "child",
      });
      x += item.size.w + CHILD_GAP_X;
    }
    y += h + CHILD_GAP_Y;
  }
  return {
    w: innerWidth + GROUP_PAD_X * 2,
    h: Math.max(150, y - CHILD_GAP_Y + GROUP_PAD_BOTTOM),
  };
}

function measureNode(node, childrenByParent, nodeLayouts, edges) {
  const children = childrenByParent.get(node.id) || [];
  if (isContainer(node) && children.length) {
    return layoutChildren(node, children, nodeLayouts, edges);
  }
  return cardSize(node);
}

export function composeArchitectureView(spec, options = {}) {
  const view = spec?.views?.architecture || { nodes: [], edges: [] };
  const nodes = view.nodes || [];
  const edges = view.edges || [];
  const maxColumns = options.maxColumns || 4;
  const minWidth = options.minWidth || 1180;
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parent) continue;
    const list = childrenByParent.get(node.parent) || [];
    list.push(node);
    childrenByParent.set(node.parent, list);
  }

  const topLevel = nodes.filter((n) => !n.parent).sort(stableNodeSort(edges));
  const byZone = new Map();
  for (const node of topLevel) {
    const zoneId = zoneIdForNode(node);
    const list = byZone.get(zoneId) || [];
    list.push(node);
    byZone.set(zoneId, list);
  }

  const nodeLayouts = new Map();
  const zoneLayouts = [];
  let y = 34;
  let maxWidth = minWidth;

  for (const zone of ZONES) {
    const zoneNodes = byZone.get(zone.id) || [];
    if (!zoneNodes.length) continue;
    const measured = zoneNodes.map((node) => ({
      node,
      size: measureNode(node, childrenByParent, nodeLayouts, edges),
      forceLeaf: isContainer(node) && !(childrenByParent.get(node.id) || []).length,
    }));
    const rows = rowsFor(measured, maxColumns);
    const contentW = Math.max(...rows.map(rowWidth), CARD_W);
    const zoneW = Math.max(minWidth, contentW + ZONE_PAD_X * 2);
    let rowY = y + ZONE_PAD_TOP;
    for (const row of rows) {
      const w = rowWidth(row);
      const h = Math.max(...row.map((item) => item.size.h), CARD_H);
      let x = ZONE_X + Math.round((zoneW - ZONE_X * 2 - w) / 2);
      for (const item of row) {
        nodeLayouts.set(item.node.id, {
          position: { x, y: rowY + Math.round((h - item.size.h) / 2) },
          size: item.size,
          role: item.forceLeaf ? "leaf" : isContainer(item.node) ? "group" : "leaf",
          forceLeaf: item.forceLeaf,
        });
        x += item.size.w + ITEM_GAP_X;
      }
      rowY += h + ITEM_GAP_Y;
    }
    const zoneH = Math.max(132, rowY - y - ITEM_GAP_Y + ZONE_PAD_BOTTOM);
    zoneLayouts.push({
      id: zone.id,
      label: zone.label,
      color: zone.color,
      position: { x: 0, y },
      size: { w: zoneW, h: zoneH },
    });
    maxWidth = Math.max(maxWidth, zoneW);
    y += zoneH + ZONE_GAP_Y;
  }

  return {
    zones: zoneLayouts.map((zone) => ({ ...zone, size: { ...zone.size, w: maxWidth } })),
    nodes: nodeLayouts,
    width: maxWidth,
    height: Math.max(640, y + 20),
    zoneForNode: (node) => ZONE_BY_ID.get(zoneIdForNode(node)) || ZONE_BY_ID.get("capabilities"),
  };
}
