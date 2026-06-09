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
import { CATEGORIES, PLANES, DELIVERY, CONSISTENCY, nodeDefaults, getType } from "../../shared/catalog.mjs";

const CAT_COLOR = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.color]));
const PLANE_COLOR = Object.fromEntries(PLANES.map((p) => [p.id, p.color]));

// Swimlane Y bands — control on top, execution middle, data bottom.
const BANDS = { control: { y: 0, h: 250 }, execution: { y: 270, h: 270 }, data: { y: 560, h: 270 } };
const bandCenterY = (plane) => BANDS[plane] ? BANDS[plane].y + BANDS[plane].h / 2 - 30 : 380;
const ZONE_W = 2200;

// Background swimlane node (non-interactive).
function ZoneNode({ data }) {
  return (
    <div className="plane-zone" style={{ width: ZONE_W, height: data.h, borderColor: data.color }}>
      <span className="plane-zone-label" style={{ color: data.color }}>{data.label}</span>
    </div>
  );
}

// A component node: category-colored, with plane badge + tech. Ringed red on violation.
function ArchNode({ data, selected }) {
  const { node, bad } = data;
  const color = CAT_COLOR[node.category] || "#cccccc";
  const plane = node.plane || "execution";
  return (
    <div className={`arch-node ${bad ? "bad" : ""} ${selected ? "sel" : ""}`} style={{ borderColor: bad ? "#ff6b6b" : color }}>
      <Handle type="target" position={Position.Left} className="arch-handle" />
      <div className="arch-kind" style={{ color }}>
        {(getType(node.type)?.label || node.type || node.kind)}
        <span className="arch-plane" style={{ background: PLANE_COLOR[plane] }}>{plane[0].toUpperCase()}</span>
      </div>
      <div className="arch-label">{node.label}</div>
      {node.tech ? <div className="arch-tech">{node.tech}</div> : null}
      <Handle type="source" position={Position.Right} className="arch-handle" />
    </div>
  );
}

const nodeTypes = { arch: ArchNode, zone: ZoneNode };

export default function Canvas({ spec, commit, catalog }) {
  const vIndex = useMemo(() => violationIndex(spec).byView.architecture, [spec]);
  const archNodes = spec.views.architecture.nodes;
  const archEdges = spec.views.architecture.edges;
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    const zones = PLANES.map((p) => ({
      id: `__zone_${p.id}`,
      type: "zone",
      position: { x: -120, y: BANDS[p.id].y },
      data: { label: p.label, color: p.color, h: BANDS[p.id].h },
      draggable: false,
      selectable: false,
      connectable: false,
      zIndex: -1,
    }));
    const comps = archNodes.map((n) => ({
      id: n.id,
      type: "arch",
      position: n.position || { x: 0, y: 0 },
      data: { node: n, bad: vIndex.nodes.has(n.id) },
      selected: n.id === selectedId,
    }));
    setRfNodes([...zones, ...comps]);
    setRfEdges(
      archEdges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        label: edgeLabel(e),
        className: vIndex.edges.has(e.id) ? "edge-bad" : "edge-ok",
      }))
    );
  }, [spec, vIndex, selectedId, archNodes, archEdges, setRfNodes, setRfEdges]);

  const onConnect = useCallback(
    (c) => commit(applyMutation(spec, { op: "connect", view: "architecture", from: c.source, to: c.target, kind: "calls", protocol: "http" })),
    [spec, commit]
  );
  const onNodeDragStop = useCallback(
    (_e, node) => {
      if (node.id.startsWith("__zone")) return;
      commit(applyMutation(spec, { op: "update_node", view: "architecture", id: node.id, position: node.position }));
    },
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
  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/adr-type");
      if (!type) return;
      const def = nodeDefaults(type, catalog);
      const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      // Land in the plane's swimlane: keep drop X, snap Y to the band.
      const position = { x: at.x, y: bandCenterY(def.plane) };
      commit(applyMutation(spec, { op: "add_node", view: "architecture", type, ...def, position }));
    },
    [spec, commit, catalog, screenToFlowPosition]
  );
  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  // Re-arrange all nodes into their plane's band.
  const tidyByPlane = useCallback(() => {
    let s = spec;
    const counts = { control: 0, execution: 0, data: 0 };
    for (const n of s.views.architecture.nodes) {
      const plane = n.plane || "execution";
      const i = counts[plane]++;
      s = applyMutation(s, { op: "update_node", view: "architecture", id: n.id, position: { x: 40 + i * 230, y: bandCenterY(plane) } });
    }
    commit(s);
  }, [spec, commit]);

  const selectedNode = archNodes.find((n) => n.id === selectedId) || null;
  const selectedEdge = archEdges.find((e) => e.id === selectedEdgeId) || null;
  const techOptions = selectedNode ? getType(selectedNode.type)?.tech || [] : [];
  const setNode = (patch) => commit(applyMutation(spec, { op: "update_node", view: "architecture", id: selectedId, ...patch }));
  const setEdgeSem = (patch) => commit(applyMutation(spec, { op: "set_edge_semantics", view: "architecture", id: selectedEdgeId, ...patch }));

  return (
    <div className="canvas-wrap" onDrop={onDrop} onDragOver={onDragOver}>
      <div className="canvas-toolbar">
        <button className="mini-btn" onClick={tidyByPlane}>Tidy by plane</button>
      </div>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
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

      {archNodes.length === 0 && (
        <div className="empty-hint">Drag a component from the catalog, or ask the assistant to sketch one.</div>
      )}

      {selectedNode && (
        <div className="inspector wide" onClick={(e) => e.stopPropagation()}>
          <div className="insp-head">{getType(selectedNode.type)?.label || selectedNode.type}</div>
          <label>Label</label>
          <input value={selectedNode.label} onChange={(e) => setNode({ label: e.target.value })} />
          <label>Plane</label>
          <select value={selectedNode.plane || "execution"} onChange={(e) => setNode({ plane: e.target.value, position: { ...selectedNode.position, y: bandCenterY(e.target.value) } })}>
            {PLANES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <label>Tech</label>
          <input list="tech-options" value={selectedNode.tech || ""} placeholder="pgvector, SQLite FTS5, Kafka…" onChange={(e) => setNode({ tech: e.target.value })} />
          <datalist id="tech-options">{techOptions.map((t) => <option key={t} value={t} />)}</datalist>
          <label>Bounded context</label>
          <input value={selectedNode.context || ""} placeholder="optional" onChange={(e) => setNode({ context: e.target.value })} />
          <label>Intent (read by the coding agent)</label>
          <textarea rows={3} value={selectedNode.notes || ""} onChange={(e) => setNode({ notes: e.target.value })} />
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
