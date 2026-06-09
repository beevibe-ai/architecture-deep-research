import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
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

const KIND_COLOR = {
  service: "#b9c5ff",
  datastore: "#9ee3c6",
  queue: "#ffd7a3",
  gateway: "#c8a7ff",
  client: "#7fd7ff",
  external: "#ffb9d5",
};

// Custom node: a pill that shows label + tech, ringed red when it participates
// in a constraint violation.
function ArchNode({ data, selected }) {
  const { node, bad } = data;
  const color = KIND_COLOR[node.kind] || "#cccccc";
  return (
    <div
      className={`arch-node ${bad ? "bad" : ""} ${selected ? "sel" : ""}`}
      style={{ borderColor: bad ? "#ff6b6b" : color }}
    >
      <Handle type="target" position={Position.Left} className="arch-handle" />
      <div className="arch-kind" style={{ color }}>
        {node.kind}
      </div>
      <div className="arch-label">{node.label}</div>
      {node.tech ? <div className="arch-tech">{node.tech}</div> : null}
      <Handle type="source" position={Position.Right} className="arch-handle" />
    </div>
  );
}

const nodeTypes = { arch: ArchNode };

export default function Canvas({ spec, commit, violations }) {
  const vIndex = useMemo(() => violationIndex(spec).byView.architecture, [spec]);
  const archNodes = spec.views.architecture.nodes;
  const archEdges = spec.views.architecture.edges;
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const { screenToFlowPosition } = useReactFlow();
  const wrapRef = useRef(null);

  // Re-derive the React Flow graph whenever the spec changes (drag commit,
  // chat edit, file reload). The spec is the single source of truth.
  useEffect(() => {
    setRfNodes(
      archNodes.map((n) => ({
        id: n.id,
        type: "arch",
        position: n.position || { x: 0, y: 0 },
        data: { node: n, bad: vIndex.nodes.has(n.id) },
        selected: n.id === selectedId,
      }))
    );
    setRfEdges(
      archEdges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        label: `${e.kind} · ${e.protocol}`,
        className: vIndex.edges.has(e.id) ? "edge-bad" : "edge-ok",
      }))
    );
  }, [spec, vIndex, selectedId, archNodes, archEdges, setRfNodes, setRfEdges]);

  const onConnect = useCallback(
    (c) =>
      commit(
        applyMutation(spec, {
          op: "connect",
          view: "architecture",
          from: c.source,
          to: c.target,
          kind: "calls",
          protocol: "http",
        })
      ),
    [spec, commit]
  );

  const onNodeDragStop = useCallback(
    (_e, node) =>
      commit(applyMutation(spec, { op: "update_node", view: "architecture", id: node.id, position: node.position })),
    [spec, commit]
  );

  const onNodesDelete = useCallback(
    (deleted) => {
      let s = spec;
      for (const d of deleted) s = applyMutation(s, { op: "remove_node", view: "architecture", ref: d.id });
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
      const kind = event.dataTransfer.getData("application/adr-kind");
      if (!kind) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      commit(applyMutation(spec, { op: "add_node", view: "architecture", kind, position }));
    },
    [spec, commit, screenToFlowPosition]
  );

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const selectedNode = archNodes.find((n) => n.id === selectedId) || null;

  const updateSelected = (patch) =>
    commit(applyMutation(spec, { op: "update_node", view: "architecture", id: selectedId, ...patch }));

  return (
    <div className="canvas-wrap" ref={wrapRef} onDrop={onDrop} onDragOver={onDragOver}>
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

      {archNodes.length === 0 && (
        <div className="empty-hint">
          Drag a component from the left, or ask the assistant to sketch one.
        </div>
      )}

      {selectedNode && (
        <div className="inspector" onClick={(e) => e.stopPropagation()}>
          <div className="insp-head">{selectedNode.kind}</div>
          <label>Label</label>
          <input
            value={selectedNode.label}
            onChange={(e) => updateSelected({ label: e.target.value })}
          />
          <label>Tech</label>
          <input
            value={selectedNode.tech}
            placeholder="Postgres, Redis, …"
            onChange={(e) => updateSelected({ tech: e.target.value })}
          />
          <label>Bounded context</label>
          <input
            value={selectedNode.context}
            placeholder="optional"
            onChange={(e) => updateSelected({ context: e.target.value })}
          />
          <label>Intent (read by the coding agent)</label>
          <textarea
            rows={3}
            value={selectedNode.notes}
            onChange={(e) => updateSelected({ notes: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}
