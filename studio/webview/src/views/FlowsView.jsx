import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  useReactFlow,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import FlowNode from "./FlowNode.jsx";
import { applyMutation, STEP_TYPES } from "../../../shared/ir.mjs";
import { violationIndex } from "../../../shared/constraints.mjs";

const nodeTypes = { step: FlowNode };

function Inner({ spec, commit }) {
  const flows = spec.views.flows;
  const [activeFlowId, setActiveFlowId] = useState(flows[0]?.id || null);
  const flow = flows.find((f) => f.id === activeFlowId) || flows[0] || null;
  const vIndex = useMemo(() => violationIndex(spec).byView.flows, [spec]);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const { screenToFlowPosition } = useReactFlow();

  // Keep a valid active flow as flows are added/removed.
  useEffect(() => {
    if (!flows.find((f) => f.id === activeFlowId)) setActiveFlowId(flows[0]?.id || null);
  }, [flows, activeFlowId]);

  useEffect(() => {
    if (!flow) {
      setRfNodes([]);
      setRfEdges([]);
      return;
    }
    setRfNodes(
      flow.nodes.map((s) => ({
        id: s.id,
        type: "step",
        position: s.position || { x: 0, y: 0 },
        data: { step: s, bad: vIndex.nodes.has(s.id) },
        selected: s.id === selectedId,
      }))
    );
    setRfEdges(
      flow.transitions.map((t) => ({
        id: t.id,
        source: t.from,
        target: t.to,
        label: t.label || "",
        className: vIndex.edges.has(t.id) ? "edge-bad" : "edge-ok",
      }))
    );
  }, [spec, flow, vIndex, selectedId, setRfNodes, setRfEdges]);

  const onConnect = useCallback(
    (c) => flow && commit(applyMutation(spec, { op: "add_transition", view: "flows", flow: flow.id, from: c.source, to: c.target })),
    [spec, commit, flow]
  );
  const onNodeDragStop = useCallback(
    (_e, node) => flow && commit(applyMutation(spec, { op: "update_step", view: "flows", flow: flow.id, id: node.id, position: node.position })),
    [spec, commit, flow]
  );
  const onNodesDelete = useCallback(
    (deleted) => {
      if (!flow) return;
      let s = spec;
      for (const d of deleted) s = applyMutation(s, { op: "remove_step", view: "flows", flow: flow.id, ref: d.id });
      setSelectedId(null);
      commit(s);
    },
    [spec, commit, flow]
  );
  const onEdgesDelete = useCallback(
    (deleted) => {
      if (!flow) return;
      let s = spec;
      for (const d of deleted) s = applyMutation(s, { op: "remove_transition", view: "flows", flow: flow.id, id: d.id });
      commit(s);
    },
    [spec, commit, flow]
  );
  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/adr-step");
      if (!type || !flow) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      commit(applyMutation(spec, { op: "add_step", view: "flows", flow: flow.id, type, position }));
    },
    [spec, commit, flow, screenToFlowPosition]
  );
  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const addFlow = () => {
    const s = applyMutation(spec, { op: "add_flow", view: "flows", name: `Flow ${flows.length + 1}` });
    commit(s);
    setActiveFlowId(s.views.flows[s.views.flows.length - 1].id);
  };

  const selected = flow ? flow.nodes.find((n) => n.id === selectedId) : null;

  return (
    <div className="view-area">
      <aside className="palette">
        <div className="palette-head">Steps</div>
        {STEP_TYPES.map((type) => (
          <div
            key={type}
            className={`chip fs-chip-${type}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/adr-step", type);
              e.dataTransfer.effectAllowed = "move";
            }}
          >
            <span className={`dot dot-${type === "decision" ? "queue" : type === "start" ? "service" : type === "end" ? "external" : "client"}`} />
            {type}
          </div>
        ))}
        <div className="palette-hint">Pick a flow, drag steps in, connect them. Add a flow with +.</div>
      </aside>

      <div className="canvas-wrap" onDrop={onDrop} onDragOver={onDragOver}>
        <div className="flow-bar">
          <select value={flow ? flow.id : ""} onChange={(e) => setActiveFlowId(e.target.value)} disabled={!flows.length}>
            {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            {!flows.length && <option value="">no flows yet</option>}
          </select>
          <button className="mini-btn" onClick={addFlow}>+ flow</button>
          {flow && (
            <button className="mini-btn ghost" onClick={() => commit(applyMutation(spec, { op: "remove_flow", view: "flows", id: flow.id }))}>
              delete flow
            </button>
          )}
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

        {!flows.length && <div className="empty-hint">Add a flow with the + button, then drag steps in.</div>}
        {flow && flow.nodes.length === 0 && <div className="empty-hint">Drag a start step in to begin “{flow.name}”.</div>}

        {selected && (
          <div className="inspector" onClick={(e) => e.stopPropagation()}>
            <div className="insp-head">{selected.type} step</div>
            <label>Label</label>
            <input value={selected.label} onChange={(e) => commit(applyMutation(spec, { op: "update_step", view: "flows", flow: flow.id, id: selected.id, label: e.target.value }))} />
            <label>Type</label>
            <select value={selected.type} onChange={(e) => commit(applyMutation(spec, { op: "update_step", view: "flows", flow: flow.id, id: selected.id, type: e.target.value }))}>
              {STEP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        )}
      </div>
    </div>
  );
}

export default function FlowsView({ spec, commit }) {
  return (
    <ReactFlowProvider>
      <Inner spec={spec} commit={commit} />
    </ReactFlowProvider>
  );
}
