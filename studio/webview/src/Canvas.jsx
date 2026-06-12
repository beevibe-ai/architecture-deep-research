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

const CAT_COLOR = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.color]));
const PLANE_COLOR = Object.fromEntries(PLANES.map((p) => [p.id, p.color]));
const PLANE_LABEL = Object.fromEntries(PLANES.map((p) => [p.id, p.label]));
const PLANE_BADGE = { control: "Control", execution: "Exec", data: "Data" };

const BANDS = { control: { y: 0, h: 250 }, execution: { y: 270, h: 270 }, data: { y: 560, h: 270 } };
const bandCenterY = (plane) => (BANDS[plane] ? BANDS[plane].y + BANDS[plane].h / 2 - 30 : 380);
const ZONE_W = 2200;

// Container component sizes (agent_runtime nests its internals).
const CONTAINER_SIZE = { agent_runtime: { w: 196, h: 268 } };
const isContainer = (type) => !!getType(type)?.container;
const containerSize = (type) => CONTAINER_SIZE[type] || { w: 220, h: 260 };

function ZoneNode({ data }) {
  return (
    <div className="plane-zone" style={{ width: data.w || ZONE_W, height: data.h, background: `${data.color}0c`, borderColor: `${data.color}2e` }}>
      <span className="plane-zone-label" style={{ background: `${data.color}26`, color: data.color }}>{data.label}</span>
    </div>
  );
}

// A container component (e.g. Agent Runtime) — a titled box children nest inside.
function ArchGroupNode({ data }) {
  const { node, bad } = data;
  const color = CAT_COLOR[node.category] || "#b9c5ff";
  return (
    <div className={`arch-group ${bad ? "bad" : ""}`} style={{ width: data.w, height: data.h, borderColor: bad ? "#ff6b6b" : color }}>
      <Handle type="target" position={Position.Left} className="arch-handle" />
      <div className="arch-group-title" style={{ color }}>{node.label}</div>
      <Handle type="source" position={Position.Right} className="arch-handle" />
    </div>
  );
}

function ArchNode({ data, selected }) {
  const { node, bad, drift } = data;
  const color = CAT_COLOR[node.category] || "#cccccc";
  const plane = node.plane || "execution";
  // drift: "phantom" = drawn but not in code; "mismatch" = tech differs from code.
  const driftClass = drift ? `drift-${drift}` : "";
  return (
    <div className={`arch-node ${bad ? "bad" : ""} ${driftClass} ${selected ? "sel" : ""}`} style={{ borderColor: bad ? "#ff6b6b" : color }}>
      <Handle type="target" position={Position.Left} className="arch-handle" />
      <div className="arch-kind" style={{ color }}>
        {getType(node.type)?.label || node.type || node.kind}
        <span className="arch-plane" title={PLANE_LABEL[plane] || plane} style={{ background: PLANE_COLOR[plane] }}>{PLANE_BADGE[plane] || plane}</span>
      </div>
      <div className="arch-label">{node.label}</div>
      {node.tech ? <div className="arch-tech">{node.tech}</div> : null}
      {drift ? <span className="arch-drift-tag">{drift === "phantom" ? "not in code" : "tech drift"}</span> : null}
      <Handle type="source" position={Position.Right} className="arch-handle" />
    </div>
  );
}

const nodeTypes = { arch: ArchNode, zone: ZoneNode, archGroup: ArchGroupNode };

function patternSuggestion(skill, spec) {
  const topLevel = spec.views.architecture.nodes
    .filter((n) => !n.parent)
    .slice(0, 24)
    .map((n) => `${n.label} (${n.type})`)
    .join(", ");
  return {
    idea: `Apply the ${skill.label} pattern`,
    context: [
      `Pattern intent: ${skill.description}`,
      "Treat this as an architecture change suggestion, not a raw template paste.",
      "Reuse, rename, or rewire matching existing components instead of creating duplicates.",
      "Call out what would be added, reused, removed, or left unchanged.",
      topLevel ? `Existing top-level components to reconcile with: ${topLevel}.` : "",
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

export default function Canvas({ spec, commit, catalog, driftStatus, onSuggest }) {
  const vIndex = useMemo(() => violationIndex(spec).byView.architecture, [spec]);
  const archNodes = spec.views.architecture.nodes;
  const archEdges = spec.views.architecture.edges;
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [layout, setLayout] = useState("free"); // "free" | "layered"
  const [showPlanes, setShowPlanes] = useState(false); // plane swimlanes off by default
  const { screenToFlowPosition } = useReactFlow();

  const byId = useMemo(() => new Map(archNodes.map((n) => [n.id, n])), [archNodes]);
  const depth = useCallback((n) => { let d = 0, c = n; while (c && c.parent) { c = byId.get(c.parent); d++; } return d; }, [byId]);

  useEffect(() => {
    const layered = layout === "layered" ? computeLayered(archNodes.filter((n) => !n.parent)) : null;
    const zones = layered
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
      const container = isContainer(n.type);
      const pos = layered && !n.parent ? layered.pos[n.id] : n.position || { x: 0, y: 0 };
      // Prefer the size auto-layout computed to fit children; else the fixed box.
      const size = container ? (n.size || containerSize(n.type)) : null;
      const base = {
        id: n.id,
        type: container ? "archGroup" : "arch",
        position: pos,
        data: { node: n, bad: vIndex.nodes.has(n.id), drift: driftStatus?.[n.id], ...(container ? size : {}) },
        selected: n.id === selectedId,
      };
      if (n.parent) { base.parentId = n.parent; base.extent = "parent"; }
      if (container) base.style = { ...size };
      return base;
    });
    setRfNodes([...zones, ...comps]);
    setRfEdges(
      archEdges.map((e) => ({
        id: e.id, source: e.from, target: e.to,
        label: edgeLabel(e),
        className: `${vIndex.edges.has(e.id) ? "edge-bad" : EDGE_KIND_CLASS[e.kind] || "edge-ok"}`,
      }))
    );
  }, [spec, vIndex, selectedId, layout, showPlanes, archNodes, archEdges, depth, driftStatus, setRfNodes, setRfEdges]);

  const onConnect = useCallback(
    (c) => commit(applyMutation(spec, { op: "connect", view: "architecture", from: c.source, to: c.target, kind: "calls", protocol: "http" })),
    [spec, commit]
  );
  const onNodeDragStop = useCallback(
    (_e, node) => { if (!node.id.startsWith("__zone")) commit(applyMutation(spec, { op: "update_node", view: "architecture", id: node.id, position: node.position })); },
    [spec, commit]
  );
  const onNodesDelete = useCallback(
    (deleted) => {
      let s = spec;
      for (const d of deleted) if (!d.id.startsWith("__zone")) s = applyMutation(s, { op: "remove_node", view: "architecture", ref: d.id });
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
  const architectureSkills = SKILLS.filter((s) => s.view === "architecture");
  const pickPattern = (value) => {
    if (!value) return;
    const direct = value.startsWith("direct:");
    const skillId = direct ? value.slice("direct:".length) : value;
    const skill = architectureSkills.find((s) => s.id === skillId);
    if (!skill) return;
    if (direct || !onSuggest) {
      commit(applyMutation(spec, { op: "apply_skill", skill: skill.id }));
      return;
    }
    onSuggest(patternSuggestion(skill, spec));
  };

  return (
    <div className="canvas-wrap" onDrop={onDrop} onDragOver={onDragOver}>
      <div className="canvas-toolbar">
        <div className="seg">
          <button className={`seg-btn ${layout === "free" ? "on" : ""}`} onClick={() => setLayout("free")}>Free</button>
          <button className={`seg-btn ${layout === "layered" ? "on" : ""}`} onClick={() => setLayout("layered")}>Layered</button>
        </div>
        <select className="mini-btn skill-select" value="" onChange={(e) => { pickPattern(e.target.value); e.target.value = ""; }}>
          <option value="">+ Pattern…</option>
          <optgroup label="Suggest architecture change">
            {architectureSkills.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </optgroup>
          <optgroup label="Add template directly">
            {architectureSkills.map((s) => <option key={`direct-${s.id}`} value={`direct:${s.id}`}>{s.label}</option>)}
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
        defaultEdgeOptions={{ type: "smoothstep" }}
        deleteKeyCode={["Backspace", "Delete"]}
        nodesDraggable={layout === "free"}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onNodeClick={(_e, n) => { if (!n.id.startsWith("__zone")) { setSelectedId(n.id); setSelectedEdgeId(null); } }}
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
  const bits = [e.protocol];
  if (e.delivery) bits.push(e.delivery);
  if (e.consistency && e.consistency !== "none") bits.push(e.consistency);
  if (e.required_role) bits.push("🔒" + e.required_role);
  if (e.instrumented) bits.push("otel");
  return bits.join(" · ");
}
