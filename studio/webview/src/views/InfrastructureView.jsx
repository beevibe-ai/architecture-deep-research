import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  useReactFlow,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import InfraPalette from "./InfraPalette.jsx";
import { applyMutation } from "../../../shared/ir.mjs";
import { violationIndex } from "../../../shared/constraints.mjs";
import { getInfraType, INFRA_EDGE_KINDS } from "../../../shared/infra.mjs";
import { post } from "../vscode.js";

// Container levels get a sized box children nest inside.
const LEVEL_SIZE = {
  cluster: { w: 1040, h: 640 },
  namespace: { w: 780, h: 470 },
  node_pool: { w: 360, h: 240 },
  workload: { w: 250, h: 150 },
};
const isContainer = (type) => !!LEVEL_SIZE[getInfraType(type)?.level];

// Pick a sensible edge kind from the endpoint types.
function inferKind(fromType, toType) {
  if (fromType === "service") return "exposes";
  if (fromType === "ingress" || fromType === "gateway_api") return "routes";
  if (fromType === "node_pool") return "schedules";
  if (["hpa", "keda_scaledobject"].includes(fromType)) return "scales";
  if (toType === "pvc") return "mounts";
  if (["image", "registry"].includes(toType)) return "pulls";
  if (getInfraType(toType)?.cloud) return "backs";
  return "exposes";
}

function GroupNode({ data }) {
  return (
    <div className={`infra-group lvl-${data.level} ${data.bad ? "bad" : ""}`} style={{ width: data.w, height: data.h }}>
      <div className="infra-group-head">{data.label} <span className="infra-type">{data.typeLabel}</span></div>
      <Handle type="target" position={Position.Top} className="arch-handle" />
      <Handle type="source" position={Position.Bottom} className="arch-handle" />
    </div>
  );
}
function LeafNode({ data, selected }) {
  return (
    <div className={`infra-leaf ${data.bad ? "bad" : ""} ${selected ? "sel" : ""}`}>
      <Handle type="target" position={Position.Left} className="arch-handle" />
      <div className="infra-leaf-type">{data.typeLabel}</div>
      <div className="infra-leaf-label">{data.label}</div>
      <Handle type="source" position={Position.Right} className="arch-handle" />
    </div>
  );
}
const nodeTypes = { infraGroup: GroupNode, infraLeaf: LeafNode };

function Inner({ spec, commit }) {
  const nodes = spec.views.infra.nodes;
  const edges = spec.views.infra.edges;
  const vIndex = useMemo(() => violationIndex(spec).byView.infra, [spec]);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const { screenToFlowPosition } = useReactFlow();

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const depth = useCallback((n) => { let d = 0, c = n; while (c && c.parent) { c = byId.get(c.parent); d++; } return d; }, [byId]);
  const absPos = useCallback((n) => {
    let x = n.position?.x || 0, y = n.position?.y || 0, c = byId.get(n.parent);
    while (c) { x += c.position?.x || 0; y += c.position?.y || 0; c = byId.get(c.parent); }
    return { x, y };
  }, [byId]);

  useEffect(() => {
    const sorted = [...nodes].sort((a, b) => depth(a) - depth(b)); // parents first
    setRfNodes(
      sorted.map((n) => {
        const t = getInfraType(n.type);
        const container = isContainer(n.type);
        const base = {
          id: n.id,
          type: container ? "infraGroup" : "infraLeaf",
          position: n.position || { x: 0, y: 0 },
          data: { label: n.label, typeLabel: t?.label || n.type, level: t?.level, bad: vIndex.nodes.has(n.id), ...(container ? LEVEL_SIZE[t.level] : {}) },
          selected: n.id === selectedId,
        };
        if (n.parent) { base.parentId = n.parent; base.extent = "parent"; }
        if (container) base.style = { width: LEVEL_SIZE[t.level].w, height: LEVEL_SIZE[t.level].h };
        return base;
      })
    );
    setRfEdges(edges.map((e) => ({ id: e.id, source: e.from, target: e.to, label: e.kind, className: vIndex.edges.has(e.id) ? "edge-bad" : "edge-ok" })));
  }, [spec, vIndex, selectedId, nodes, edges, depth, setRfNodes, setRfEdges]);

  // Deepest container whose absolute rect contains the point.
  const containerAt = useCallback((pt) => {
    let best = null, bestDepth = -1;
    for (const n of nodes) {
      if (!isContainer(n.type)) continue;
      const size = LEVEL_SIZE[getInfraType(n.type).level];
      const a = absPos(n);
      if (pt.x >= a.x && pt.x <= a.x + size.w && pt.y >= a.y && pt.y <= a.y + size.h) {
        const d = depth(n);
        if (d > bestDepth) { best = n; bestDepth = d; best._abs = a; }
      }
    }
    return best;
  }, [nodes, absPos, depth]);

  const onDrop = useCallback((event) => {
    event.preventDefault();
    const type = event.dataTransfer.getData("application/adr-infra");
    if (!type) return;
    const pt = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const parentNode = containerAt(pt);
    const position = parentNode ? { x: pt.x - parentNode._abs.x, y: pt.y - parentNode._abs.y } : pt;
    commit(applyMutation(spec, { op: "add_infra", view: "infra", type, parent: parentNode ? parentNode.id : null, position }));
  }, [spec, commit, screenToFlowPosition, containerAt]);
  const onDragOver = useCallback((e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }, []);

  const onConnect = useCallback((c) => {
    const ft = byId.get(c.source)?.type, tt = byId.get(c.target)?.type;
    commit(applyMutation(spec, { op: "connect_infra", view: "infra", from: c.source, to: c.target, kind: inferKind(ft, tt) }));
  }, [spec, commit, byId]);
  const onNodeDragStop = useCallback((_e, node) => commit(applyMutation(spec, { op: "update_infra", view: "infra", id: node.id, position: node.position })), [spec, commit]);
  const onNodesDelete = useCallback((deleted) => {
    let s = spec;
    for (const d of deleted) s = applyMutation(s, { op: "remove_infra", view: "infra", ref: d.id });
    setSelectedId(null);
    commit(s);
  }, [spec, commit]);
  const onEdgesDelete = useCallback((deleted) => {
    let s = spec;
    for (const d of deleted) s = applyMutation(s, { op: "disconnect_infra", view: "infra", id: d.id });
    commit(s);
  }, [spec, commit]);

  const selected = nodes.find((n) => n.id === selectedId) || null;
  const containers = nodes.filter((n) => isContainer(n.type) && n.id !== selectedId);
  const components = spec.views.architecture.nodes;
  const realizesRef = selected && (spec.cross_refs || []).find((x) => x.kind === "deployed_as" && x.to.view === "infra" && x.to.ref === selected.id);
  const setProp = (k, v) => commit(applyMutation(spec, { op: "set_infra_props", view: "infra", id: selected.id, props: { [k]: v } }));
  const setRealizes = (compId) => {
    let s = spec;
    if (realizesRef) s = applyMutation(s, { op: "remove_cross_ref", id: realizesRef.id });
    if (compId) s = applyMutation(s, { op: "add_cross_ref", from: { view: "architecture", ref: compId }, to: { view: "infra", ref: selected.id }, kind: "deployed_as" });
    commit(s);
  };

  return (
    <div className="view-area">
      <InfraPalette />
      <div className="canvas-wrap" onDrop={onDrop} onDragOver={onDragOver}>
        <div className="canvas-toolbar">
          <button className="mini-btn" onClick={() => post({ type: "writeManifests", spec })}>Generate manifests</button>
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
          onNodeClick={(_e, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} color="#2a2d3a" />
          <Controls />
        </ReactFlow>

        {nodes.length === 0 && <div className="empty-hint">Drag a Cluster in, then nest namespaces and workloads — or ask the assistant to deploy your architecture.</div>}

        {selected && (
          <div className="inspector wide" onClick={(e) => e.stopPropagation()}>
            <div className="insp-head">{getInfraType(selected.type)?.label || selected.type}</div>
            <label>Label</label>
            <input value={selected.label} onChange={(e) => commit(applyMutation(spec, { op: "update_infra", view: "infra", id: selected.id, label: e.target.value }))} />
            <label>Inside</label>
            <select value={selected.parent || ""} onChange={(e) => commit(applyMutation(spec, { op: "update_infra", view: "infra", id: selected.id, parent: e.target.value || null }))}>
              <option value="">— top level —</option>
              {containers.map((c) => <option key={c.id} value={c.id}>{c.label} ({getInfraType(c.type)?.label})</option>)}
            </select>
            <label>Realizes (component)</label>
            <select value={realizesRef ? realizesRef.from.ref : ""} onChange={(e) => setRealizes(e.target.value)}>
              <option value="">— none —</option>
              {components.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            {Object.keys(selected.props || {}).length > 0 && <div className="insp-fields-head"><span>Config</span></div>}
            {Object.entries(selected.props || {}).map(([k, v]) => (
              <div className="prop-row" key={k}>
                <span className="prop-key">{k}</span>
                {typeof v === "boolean" ? (
                  <input type="checkbox" checked={v} onChange={(e) => setProp(k, e.target.checked)} />
                ) : typeof v === "number" ? (
                  <input type="number" value={v} onChange={(e) => setProp(k, Number(e.target.value))} />
                ) : (
                  <input value={v} onChange={(e) => setProp(k, e.target.value)} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function InfrastructureView({ spec, commit }) {
  return (
    <ReactFlowProvider>
      <Inner spec={spec} commit={commit} />
    </ReactFlowProvider>
  );
}
