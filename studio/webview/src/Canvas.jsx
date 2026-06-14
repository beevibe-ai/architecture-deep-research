import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useReactFlow,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import { applyMutation, EDGE_KINDS, PROTOCOLS } from "../../shared/ir.mjs";
import { violationIndex } from "../../shared/constraints.mjs";
import { CATEGORIES, PLANES, DELIVERY, CONSISTENCY, LAYERS, nodeDefaults, getType, layerForNode, layerLabel } from "../../shared/catalog.mjs";
import { SKILLS } from "../../shared/skills.mjs";
import { composeArchitectureView } from "../../shared/composer.mjs";

const CAT_COLOR = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.color]));
const PLANE_COLOR = Object.fromEntries(PLANES.map((p) => [p.id, p.color]));
const PLANE_LABEL = Object.fromEntries(PLANES.map((p) => [p.id, p.label]));
const PLANE_BADGE = { control: "Control", execution: "Exec", data: "Data" };
const ARCH_SKILLS = SKILLS.filter((s) => s.view === "architecture");
const SKILL_FINGERPRINTS = {
  agent_runtime: ["agent_runtime", "state_manager", "task_queue", "scheduler", "logger", "monitor"],
  agentic_rag: ["semantic_gateway", "orchestrator", "service", "vector_db", "llm_provider"],
  memory_subsystem: ["memory_manager", "working_memory", "long_term_memory", "episodic_store", "vector_db"],
  three_tier_web: ["client", "gateway", "service", "relational_db"],
  event_driven: ["event_queue", "worker", "service"],
  observability_stack: ["otel_collector", "tracer", "metrics", "log_sink"],
};

const BANDS = { control: { y: 0, h: 250 }, execution: { y: 270, h: 270 }, data: { y: 560, h: 270 } };
const bandCenterY = (plane) => (BANDS[plane] ? BANDS[plane].y + BANDS[plane].h / 2 - 30 : 380);
const ZONE_W = 2200;

// Container component sizes (agent_runtime nests its internals).
const CONTAINER_SIZE = { agent_runtime: { w: 196, h: 268 } };
const isContainer = (type) => !!getType(type)?.container;
const containerSize = (type) => CONTAINER_SIZE[type] || { w: 220, h: 260 };
const DEFAULT_NODE_SIZE = { w: 180, h: 80 };
const HANDLE_POSITIONS = [
  ["left", Position.Left],
  ["right", Position.Right],
  ["top", Position.Top],
  ["bottom", Position.Bottom],
];

function ZoneNode({ data }) {
  return (
    <div className={`plane-zone ${data.variant || ""}`} style={{ width: data.w || ZONE_W, height: data.h, background: `${data.color}0c`, borderColor: `${data.color}2e` }}>
      <span className="plane-zone-label" style={{ background: `${data.color}26`, color: data.color }}>{data.label}</span>
    </div>
  );
}

// A container component (e.g. Agent Runtime) — a titled box children nest inside.
function ArchGroupNode({ data }) {
  const { node, bad, change } = data;
  const color = CAT_COLOR[node.category] || "#b9c5ff";
  return (
    <div className={`arch-group ${data.viewMode === "composed" ? "composed" : ""} ${bad ? "bad" : ""} ${change ? `change-${change}` : ""}`} style={{ width: data.w, height: data.h, borderColor: bad ? "#ff6b6b" : color }}>
      <ArchHandles />
      <div className="arch-group-title" style={{ color }}>{node.label}</div>
      {change ? <span className={`arch-change-tag ${change}`}>{changeLabel(change)}</span> : null}
    </div>
  );
}

function ArchNode({ data, selected }) {
  const { node, bad, drift, change } = data;
  const color = CAT_COLOR[node.category] || "#cccccc";
  const plane = node.plane || "execution";
  // drift: "phantom" = drawn but not in code; "mismatch" = tech differs from code.
  const driftClass = drift ? `drift-${drift}` : "";
  const style = {
    borderColor: bad ? "#ff6b6b" : color,
    ...(data.w ? { width: data.w, minHeight: data.h } : {}),
  };
  return (
    <div className={`arch-node ${data.viewMode === "composed" ? "composed" : ""} ${bad ? "bad" : ""} ${driftClass} ${change ? `change-${change}` : ""} ${selected ? "sel" : ""}`} style={style}>
      <ArchHandles />
      <div className="arch-kind" style={{ color }}>
        {getType(node.type)?.label || node.type || node.kind}
        <span className="arch-plane" title={PLANE_LABEL[plane] || plane} style={{ background: PLANE_COLOR[plane] }}>{PLANE_BADGE[plane] || plane}</span>
      </div>
      <div className="arch-label">{node.label}</div>
      {node.tech ? <div className="arch-tech">{node.tech}</div> : null}
      {drift ? <span className="arch-drift-tag">{drift === "phantom" ? "not in code" : "tech drift"}</span> : null}
      {change ? <span className={`arch-change-tag ${change}`}>{changeLabel(change)}</span> : null}
    </div>
  );
}

const nodeTypes = { arch: ArchNode, zone: ZoneNode, archGroup: ArchGroupNode };

function ArchHandles() {
  return (
    <>
      {HANDLE_POSITIONS.map(([side, position]) => (
        <Handle key={`target-${side}`} id={`target-${side}`} type="target" position={position} className={`arch-handle arch-handle-${side} arch-handle-target`} />
      ))}
      {HANDLE_POSITIONS.map(([side, position]) => (
        <Handle key={`source-${side}`} id={`source-${side}`} type="source" position={position} className={`arch-handle arch-handle-${side} arch-handle-source`} />
      ))}
    </>
  );
}

function changeLabel(change) {
  return change === "added" ? "new" : "changed";
}

function absoluteBox(id, visualById, seen = new Set()) {
  const box = visualById.get(id);
  if (!box || seen.has(id)) return box || null;
  if (!box.parentId) return box;
  seen.add(id);
  const parent = absoluteBox(box.parentId, visualById, seen);
  if (!parent) return box;
  return { ...box, x: parent.x + box.x, y: parent.y + box.y };
}

function handlePairForEdge(edge, visualById) {
  const from = absoluteBox(edge.from, visualById);
  const to = absoluteBox(edge.to, visualById);
  if (!from || !to) return {};
  const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  const vertical = Math.abs(dy) > Math.abs(dx) * 0.75;
  if (vertical) {
    return dy >= 0
      ? { sourceHandle: "source-bottom", targetHandle: "target-top" }
      : { sourceHandle: "source-top", targetHandle: "target-bottom" };
  }
  return dx >= 0
    ? { sourceHandle: "source-right", targetHandle: "target-left" }
    : { sourceHandle: "source-left", targetHandle: "target-right" };
}

function summarizeCurrentLayout(nodes, layout) {
  const topLevel = nodes.filter((n) => !n.parent);
  const byLayer = new Map();
  for (const n of topLevel) {
    const layer = layerLabel(layerForNode(n));
    const list = byLayer.get(layer) || [];
    list.push(n.label);
    byLayer.set(layer, list);
  }
  const bands = [...byLayer.entries()]
    .slice(0, 8)
    .map(([layer, labels]) => `${layer}: ${labels.slice(0, 5).join(", ")}${labels.length > 5 ? "..." : ""}`);
  return [
    `Current canvas mode: ${layout}.`,
    `Top-level components: ${topLevel.length}.`,
    bands.length ? `Current bands: ${bands.join(" | ")}` : "",
  ].filter(Boolean).join("\n");
}

function analyzeSkill(skill, nodes, edges) {
  const fingerprint = SKILL_FINGERPRINTS[skill.id] || [];
  const byType = new Map();
  for (const n of nodes) byType.set(n.type, (byType.get(n.type) || 0) + 1);
  const present = fingerprint.filter((type) => byType.has(type));
  const missing = fingerprint.filter((type) => !byType.has(type));
  const duplicateTypes = fingerprint.filter((type) => (byType.get(type) || 0) > 1);
  const coverage = fingerprint.length ? present.length / fingerprint.length : 0;
  const serviceCount = nodes.filter((n) => n.type === "service" || n.kind === "service").length;
  const hasExternalClient = nodes.some((n) => n.type === "client" || n.kind === "client");
  const hasGateway = nodes.some((n) => n.kind === "gateway");
  const hasDataStore = nodes.some((n) => n.kind === "datastore");
  const hasEvents = nodes.some((n) => n.type === "event_queue") || edges.some((e) => ["publishes", "subscribes", "streams"].includes(e.kind));

  let action = "Consider";
  let reason = "not represented yet";
  let score = 10;
  if (coverage >= 0.75) {
    action = duplicateTypes.length ? "Clean up" : "Review";
    reason = duplicateTypes.length ? "duplicates likely" : "mostly present";
    score = duplicateTypes.length ? 95 : 45;
  } else if (coverage > 0) {
    action = "Extend";
    reason = `${present.length}/${fingerprint.length} pieces present`;
    score = 80 + present.length;
  }

  if (skill.id === "observability_stack" && serviceCount >= 3 && coverage === 0) {
    action = "Add";
    reason = "services lack observability";
    score = 70;
  } else if (skill.id === "event_driven" && serviceCount >= 3 && !hasEvents) {
    action = "Consider";
    reason = "several services could decouple";
    score = 62;
  } else if (skill.id === "three_tier_web" && hasExternalClient && !hasGateway) {
    action = "Review";
    reason = "external entry lacks gateway";
    score = 88;
  } else if (skill.id === "memory_subsystem" && hasDataStore && coverage > 0 && coverage < 0.75) {
    action = "Extend";
    reason = "memory pieces are partial";
    score = 86;
  }

  return {
    skill,
    action,
    reason,
    score,
    coverage,
    present,
    missing,
    duplicateTypes,
    recommended: score >= 60,
    label: `${action} ${skill.label} — ${reason}`,
  };
}

function patternSuggestion(choice, spec, layout) {
  const { skill, present, missing, duplicateTypes, reason } = choice;
  return {
    idea: `${choice.action} the ${skill.label} pattern`,
    context: [
      `Pattern intent: ${skill.description}`,
      `Why this is suggested now: ${reason}.`,
      present.length ? `Already present by type: ${present.join(", ")}.` : "No matching pattern pieces are clearly present yet.",
      missing.length ? `Missing by type: ${missing.join(", ")}.` : "No obvious required pieces are missing.",
      duplicateTypes.length ? `Possible duplicate types to reconcile: ${duplicateTypes.join(", ")}.` : "",
      summarizeCurrentLayout(spec.views.architecture.nodes, layout),
      "Treat this as an architecture change suggestion, not a raw template paste.",
      "Prefer updating, reusing, renaming, removing, or rewiring existing components over adding new boxes.",
      "If the pattern is already mostly present, propose cleanup or a no-op rationale instead of growing the diagram.",
      "Call out what would be added, reused, removed, or left unchanged.",
    ].filter(Boolean).join("\n"),
  };
}

// Edge color by kind (matches a small legend) — request/data vs event vs internal.
const EDGE_KIND_CLASS = { calls: "ek-call", streams: "ek-event", publishes: "ek-event", subscribes: "ek-event", owns: "ek-own" };

// Layered "big picture" layout: stack components into named layer bands.
const LAYER_H = 158, LAYER_GAP = 18, NODE_W = 220, NODE_GAP = 34, PAD_X = 70, PAD_TOP = 30, BAND_W = 2200;
function computeLayered(topLevel) {
  const used = LAYERS.filter((l) => topLevel.some((n) => layerForNode(n) === l.id));
  const bandY = {};
  used.forEach((l, i) => { bandY[l.id] = PAD_TOP + i * (LAYER_H + LAYER_GAP); });
  const counts = {};
  const pos = {};
  for (const n of topLevel) {
    const lid = layerForNode(n);
    const idx = counts[lid] = (counts[lid] || 0) + 1;
    pos[n.id] = { x: PAD_X + (idx - 1) * (NODE_W + NODE_GAP), y: bandY[lid] + 34 };
  }
  return { used, bandY, pos };
}

export default function Canvas({ spec, commit, catalog, driftStatus, changeHighlights, onSuggest }) {
  const vIndex = useMemo(() => violationIndex(spec).byView.architecture, [spec]);
  const archNodes = spec.views.architecture.nodes;
  const archEdges = spec.views.architecture.edges;
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [layout, setLayout] = useState("composed"); // "free" | "layered" | "composed"
  const [showPlanes, setShowPlanes] = useState(false); // plane swimlanes off by default
  const { screenToFlowPosition } = useReactFlow();

  const byId = useMemo(() => new Map(archNodes.map((n) => [n.id, n])), [archNodes]);
  const depth = useCallback((n) => { let d = 0, c = n; while (c && c.parent) { c = byId.get(c.parent); d++; } return d; }, [byId]);

  useEffect(() => {
    const composed = layout === "composed" ? composeArchitectureView(spec) : null;
    const layered = layout === "layered" ? computeLayered(archNodes.filter((n) => !n.parent)) : null;
    const zones = composed
      ? composed.zones.map((z) => ({
          id: `__smart_${z.id}`, type: "zone",
          position: z.position,
          data: { label: z.label, color: z.color, h: z.size.h, w: z.size.w, variant: "composed" },
          draggable: false, selectable: false, connectable: false, zIndex: -1,
        }))
      : layered
      ? layered.used.map((l) => ({
          id: `__layer_${l.id}`, type: "zone",
          position: { x: -120, y: layered.bandY[l.id] },
          data: { label: l.label, color: "#8a93b0", h: LAYER_H, w: BAND_W },
          draggable: false, selectable: false, connectable: false, zIndex: -1,
        }))
      : showPlanes
      ? PLANES.map((p) => ({
          id: `__zone_${p.id}`, type: "zone",
          position: { x: -120, y: BANDS[p.id].y },
          data: { label: p.label, color: p.color, h: BANDS[p.id].h },
          draggable: false, selectable: false, connectable: false, zIndex: -1,
        }))
      : [];
    const sorted = [...archNodes].sort((a, b) => depth(a) - depth(b)); // parents before children
    const comps = sorted.map((n) => {
      const composedInfo = composed?.nodes.get(n.id);
      const container = isContainer(n.type) && !composedInfo?.forceLeaf;
      const pos = composedInfo?.position || (layered && !n.parent ? layered.pos[n.id] : n.position || { x: 0, y: 0 });
      // Prefer the size auto-layout computed to fit children; else the fixed box.
      const size = composedInfo?.size || (container ? (n.size || containerSize(n.type)) : null);
      const base = {
        id: n.id,
        type: container ? "archGroup" : "arch",
        position: pos,
        data: { node: n, bad: vIndex.nodes.has(n.id), drift: driftStatus?.[n.id], change: changeHighlights?.nodes?.[n.id], viewMode: layout, ...(size ? size : {}) },
        selected: n.id === selectedId,
      };
      if (n.parent) { base.parentId = n.parent; base.extent = "parent"; }
      if (container) base.style = { ...size };
      return base;
    });
    const visualById = new Map(comps.map((n) => {
      const size = n.data.w ? { w: n.data.w, h: n.data.h } : DEFAULT_NODE_SIZE;
      return [n.id, { x: n.position.x, y: n.position.y, parentId: n.parentId || null, ...size }];
    }));
    setRfNodes([...zones, ...comps]);
    setRfEdges(
      archEdges.map((e) => {
        const change = changeHighlights?.edges?.[e.id];
        return {
          id: e.id, source: e.from, target: e.to,
          ...handlePairForEdge(e, visualById),
          type: "simplebezier",
          interactionWidth: 18,
          label: e.id === selectedEdgeId ? edgeLabel(e) : compactEdgeLabel(e),
          className: `${layout === "composed" ? "composed-edge" : ""} ${vIndex.edges.has(e.id) ? "edge-bad" : EDGE_KIND_CLASS[e.kind] || "edge-ok"} ${change ? `edge-change-${change}` : ""}`,
        };
      })
    );
  }, [spec, vIndex, selectedId, selectedEdgeId, layout, showPlanes, archNodes, archEdges, depth, driftStatus, changeHighlights, setRfNodes, setRfEdges]);

  const onConnect = useCallback(
    (c) => commit(applyMutation(spec, { op: "connect", view: "architecture", from: c.source, to: c.target, kind: "calls", protocol: "http" })),
    [spec, commit]
  );
  const onNodeDragStop = useCallback(
    (_e, node) => { if (!node.id.startsWith("__")) commit(applyMutation(spec, { op: "update_node", view: "architecture", id: node.id, position: node.position })); },
    [spec, commit]
  );
  const onNodesDelete = useCallback(
    (deleted) => {
      let s = spec;
      for (const d of deleted) if (!d.id.startsWith("__")) s = applyMutation(s, { op: "remove_node", view: "architecture", ref: d.id });
      setSelectedId(null);
      commit(s);
    },
    [spec, commit]
  );
  const onEdgesDelete = useCallback(
    (deleted) => {
      let s = spec;
      for (const d of deleted) s = applyMutation(s, { op: "disconnect", view: "architecture", id: d.id });
      commit(s);
    },
    [spec, commit]
  );

  // Deepest top-level container component whose rect contains the point.
  const containerAt = useCallback((pt) => {
    let best = null;
    for (const n of archNodes) {
      if (!isContainer(n.type) || n.parent) continue;
      const size = containerSize(n.type);
      const a = n.position || { x: 0, y: 0 };
      if (pt.x >= a.x && pt.x <= a.x + size.w && pt.y >= a.y && pt.y <= a.y + size.h) best = n;
    }
    return best;
  }, [archNodes]);

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/adr-type");
      if (!type) return;
      const def = nodeDefaults(type, catalog);
      const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const parent = containerAt(at);
      if (parent) {
        const position = { x: at.x - parent.position.x, y: at.y - parent.position.y };
        commit(applyMutation(spec, { op: "add_node", view: "architecture", type, ...def, parent: parent.id, position }));
      } else {
        const position = isContainer(type) ? at : { x: at.x, y: bandCenterY(def.plane) };
        commit(applyMutation(spec, { op: "add_node", view: "architecture", type, ...def, position }));
      }
    },
    [spec, commit, catalog, screenToFlowPosition, containerAt]
  );
  const onDragOver = useCallback((e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }, []);

  const tidyByPlane = useCallback(() => {
    let s = spec;
    const counts = { control: 0, execution: 0, data: 0 };
    for (const n of s.views.architecture.nodes) {
      if (n.parent) continue; // leave nested internals where they are
      const plane = n.plane || "execution";
      const i = counts[plane]++;
      s = applyMutation(s, { op: "update_node", view: "architecture", id: n.id, position: { x: 40 + i * 250, y: bandCenterY(plane) } });
    }
    commit(s);
  }, [spec, commit]);

  const scaffoldRuntime = useCallback(() => commit(applyMutation(spec, { op: "scaffold_runtime" })), [spec, commit]);

  const selectedNode = archNodes.find((n) => n.id === selectedId) || null;
  const selectedEdge = archEdges.find((e) => e.id === selectedEdgeId) || null;
  const techOptions = selectedNode ? getType(selectedNode.type)?.tech || [] : [];
  const containers = archNodes.filter((n) => isContainer(n.type) && n.id !== selectedId);
  const setNode = (patch) => commit(applyMutation(spec, { op: "update_node", view: "architecture", id: selectedId, ...patch }));
  const setEdgeSem = (patch) => commit(applyMutation(spec, { op: "set_edge_semantics", view: "architecture", id: selectedEdgeId, ...patch }));
  const patternChoices = useMemo(() => {
    const choices = ARCH_SKILLS.map((skill) => analyzeSkill(skill, archNodes, archEdges));
    return {
      recommended: choices.filter((c) => c.recommended).sort((a, b) => b.score - a.score),
      other: choices.filter((c) => !c.recommended).sort((a, b) => b.score - a.score),
    };
  }, [archNodes, archEdges]);
  const pickPattern = (value) => {
    if (!value) return;
    const choice = [...patternChoices.recommended, ...patternChoices.other].find((c) => c.skill.id === value);
    if (!choice || !onSuggest) return;
    onSuggest(patternSuggestion(choice, spec, layout));
  };

  return (
    <div className="canvas-wrap" onDrop={onDrop} onDragOver={onDragOver}>
      <div className="canvas-toolbar">
        <div className="seg">
          <button className={`seg-btn ${layout === "free" ? "on" : ""}`} onClick={() => setLayout("free")}>Free</button>
          <button className={`seg-btn ${layout === "layered" ? "on" : ""}`} onClick={() => setLayout("layered")}>Layered</button>
          <button className={`seg-btn ${layout === "composed" ? "on" : ""}`} onClick={() => setLayout("composed")}>Composed</button>
        </div>
        <select className="mini-btn skill-select" value="" onChange={(e) => { pickPattern(e.target.value); e.target.value = ""; }}>
          <option value="">Suggest change…</option>
          {patternChoices.recommended.length > 0 && (
            <optgroup label="Recommended for this diagram">
              {patternChoices.recommended.map((c) => <option key={c.skill.id} value={c.skill.id}>{c.label}</option>)}
            </optgroup>
          )}
          <optgroup label={patternChoices.recommended.length ? "Other pattern reviews" : "Pattern reviews"}>
            {patternChoices.other.map((c) => <option key={c.skill.id} value={c.skill.id}>{c.label}</option>)}
          </optgroup>
        </select>
        {layout === "free" && <button className="mini-btn" onClick={() => commit(applyMutation(spec, { op: "auto_layout", view: "architecture", direction: "TB" }))}>Auto-arrange</button>}
        {layout === "free" && <button className={`mini-btn ${showPlanes ? "on" : ""}`} onClick={() => setShowPlanes((v) => !v)}>Planes</button>}
        {layout === "free" && showPlanes && <button className="mini-btn" onClick={tidyByPlane}>Tidy by plane</button>}
      </div>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={{ type: "simplebezier" }}
        deleteKeyCode={["Backspace", "Delete"]}
        nodesDraggable={layout === "free"}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onNodeClick={(_e, n) => { if (!n.id.startsWith("__")) { setSelectedId(n.id); setSelectedEdgeId(null); } }}
        onEdgeClick={(_e, ed) => { setSelectedEdgeId(ed.id); setSelectedId(null); }}
        onPaneClick={() => { setSelectedId(null); setSelectedEdgeId(null); }}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} color="#2a2d3a" />
        <Controls />
      </ReactFlow>

      <div className="edge-legend">
        <span><i className="lg ek-call" /> request / data</span>
        <span><i className="lg ek-event" /> event</span>
        <span><i className="lg ek-own" /> owns</span>
      </div>

      {archNodes.length === 0 && (
        <div className="empty-hint">Drag a component from the catalog, drop “+ Agent Runtime”, or ask the assistant.</div>
      )}

      {selectedNode && (
        <div className="inspector wide" onClick={(e) => e.stopPropagation()}>
          <div className="insp-head">{getType(selectedNode.type)?.label || selectedNode.type}</div>
          <label>Label</label>
          <input value={selectedNode.label} onChange={(e) => setNode({ label: e.target.value })} />
          <label>Plane</label>
          <select value={selectedNode.plane || "execution"} onChange={(e) => setNode({ plane: e.target.value, ...(selectedNode.parent ? {} : { position: { ...selectedNode.position, y: bandCenterY(e.target.value) } }) })}>
            {PLANES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <label>Inside (container)</label>
          <select value={selectedNode.parent || ""} onChange={(e) => setNode({ parent: e.target.value || null })}>
            <option value="">— top level —</option>
            {containers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <label>Layer (big-picture band)</label>
          <select value={selectedNode.layer || layerForNode(selectedNode)} onChange={(e) => setNode({ layer: e.target.value })}>
            {LAYERS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
          <label>Tech</label>
          <input list="tech-options" value={selectedNode.tech || ""} placeholder="pgvector, SQLite FTS5, Kafka…" onChange={(e) => setNode({ tech: e.target.value })} />
          <datalist id="tech-options">{techOptions.map((t) => <option key={t} value={t} />)}</datalist>
          <label>Intent (read by the coding agent)</label>
          <textarea rows={3} value={selectedNode.notes || ""} onChange={(e) => setNode({ notes: e.target.value })} />
          <button className="mini-btn danger" onClick={() => { commit(applyMutation(spec, { op: "remove_node", view: "architecture", id: selectedNode.id })); setSelectedId(null); }}>
            Delete {getType(selectedNode.type)?.container ? "(and its internals)" : "component"}
          </button>
        </div>
      )}

      {selectedEdge && (
        <div className="inspector wide" onClick={(e) => e.stopPropagation()}>
          <div className="insp-head">edge semantics</div>
          <label>Protocol</label>
          <select value={selectedEdge.protocol || "http"} onChange={(e) => setEdgeSem({ protocol: e.target.value })}>
            {PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <label>Kind</label>
          <select value={selectedEdge.kind || "calls"} onChange={(e) => setEdgeSem({ kind: e.target.value })}>
            {EDGE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <label>Delivery</label>
          <select value={selectedEdge.delivery || ""} onChange={(e) => setEdgeSem({ delivery: e.target.value || null })}>
            <option value="">—</option>
            {DELIVERY.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <label>Consistency</label>
          <select value={selectedEdge.consistency || ""} onChange={(e) => setEdgeSem({ consistency: e.target.value || null })}>
            <option value="">—</option>
            {CONSISTENCY.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <label>Required role (RBAC)</label>
          <input value={selectedEdge.required_role || ""} placeholder="e.g. admin" onChange={(e) => setEdgeSem({ required_role: e.target.value || null })} />
          <label className="f-pk"><input type="checkbox" checked={!!selectedEdge.instrumented} onChange={(e) => setEdgeSem({ instrumented: e.target.checked })} /> OTel instrumented</label>
          <button className="mini-btn danger" onClick={() => { commit(applyMutation(spec, { op: "disconnect", view: "architecture", id: selectedEdge.id })); setSelectedEdgeId(null); }}>Delete edge</button>
        </div>
      )}
    </div>
  );
}

function edgeLabel(e) {
  const bits = [e.label || e.protocol];
  if (e.delivery) bits.push(e.delivery);
  if (e.consistency && e.consistency !== "none") bits.push(e.consistency);
  if (e.required_role) bits.push("🔒" + e.required_role);
  if (e.instrumented) bits.push("otel");
  return bits.join(" · ");
}

function compactEdgeLabel(e) {
  if (e.kind === "publishes" || e.kind === "subscribes" || e.kind === "streams") return e.label || e.protocol || "event";
  if (e.kind === "owns") return "owns";
  return e.label || e.protocol || "";
}
