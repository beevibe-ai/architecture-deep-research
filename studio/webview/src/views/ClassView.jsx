import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  useReactFlow,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import { applyMutation, CLASS_EDGE_KINDS, VISIBILITIES } from "../../../shared/ir.mjs";

// A UML class: «stereotype» + name, an attributes compartment, a methods one.
function ClassNode({ data, selected }) {
  const { node } = data;
  const attrs = node.members.filter((m) => m.kind === "attribute");
  const methods = node.members.filter((m) => m.kind === "method");
  return (
    <div className={`uml-class ${selected ? "sel" : ""}`}>
      <Handle type="target" position={Position.Top} className="arch-handle" />
      <div className="uml-head">
        {node.stereotype && <div className="uml-stereo">«{node.stereotype}»</div>}
        <div className="uml-name">{node.name}</div>
      </div>
      <div className="uml-compartment">
        {attrs.length === 0 && <div className="uml-member empty">—</div>}
        {attrs.map((m) => <div className="uml-member" key={m.id}>{m.visibility}{m.name}{m.type ? ` : ${m.type}` : ""}</div>)}
      </div>
      <div className="uml-compartment">
        {methods.length === 0 && <div className="uml-member empty">—</div>}
        {methods.map((m) => <div className="uml-member" key={m.id}>{m.visibility}{m.name}{m.type ? ` : ${m.type}` : ""}</div>)}
      </div>
      <Handle type="source" position={Position.Bottom} className="arch-handle" />
    </div>
  );
}
const nodeTypes = { uml: ClassNode };

function Inner({ spec, commit }) {
  const classes = spec.views.classes.nodes;
  const edges = spec.views.classes.edges;
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    setRfNodes(classes.map((c) => ({ id: c.id, type: "uml", position: c.position || { x: 0, y: 0 }, data: { node: c }, selected: c.id === selectedId })));
    setRfEdges(edges.map((e) => ({
      id: e.id, source: e.from, target: e.to, label: e.kind,
      // Inheritance points to the parent with a hollow triangle (Mermaid-style).
      markerEnd: { type: e.kind === "inherits" || e.kind === "implements" ? MarkerType.ArrowClosed : MarkerType.Arrow },
      className: `cl-${e.kind}`,
    })));
  }, [spec, selectedId, classes, edges, setRfNodes, setRfEdges]);

  const onConnect = useCallback((c) => commit(applyMutation(spec, { op: "connect_class", view: "classes", from: c.source, to: c.target, kind: "inherits" })), [spec, commit]);
  const onNodeDragStop = useCallback((_e, n) => commit(applyMutation(spec, { op: "update_class", view: "classes", id: n.id, position: n.position })), [spec, commit]);
  const onNodesDelete = useCallback((dl) => { let s = spec; for (const d of dl) s = applyMutation(s, { op: "remove_class", view: "classes", ref: d.id }); setSelectedId(null); commit(s); }, [spec, commit]);
  const onEdgesDelete = useCallback((dl) => { let s = spec; for (const d of dl) s = applyMutation(s, { op: "disconnect_class", view: "classes", id: d.id }); commit(s); }, [spec, commit]);
  const onDrop = useCallback((event) => {
    event.preventDefault();
    if (event.dataTransfer.getData("application/adr-class") !== "1") return;
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    commit(applyMutation(spec, { op: "add_class", view: "classes", name: "NewClass", position, members: [{ kind: "attribute", name: "field", type: "string" }] }));
  }, [spec, commit, screenToFlowPosition]);
  const onDragOver = useCallback((e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }, []);

  const selected = classes.find((c) => c.id === selectedId) || null;
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) || null;
  const setClass = (patch) => commit(applyMutation(spec, { op: "update_class", view: "classes", id: selectedId, ...patch }));
  const setMember = (memberId, patch) => commit(applyMutation(spec, { op: "update_member", view: "classes", class: selectedId, member: memberId, ...patch }));

  return (
    <div className="view-area">
      <aside className="palette">
        <div className="palette-head">UML</div>
        <div className="chip chip-service" draggable onDragStart={(e) => { e.dataTransfer.setData("application/adr-class", "1"); e.dataTransfer.effectAllowed = "move"; }}>
          <span className="dot dot-service" /> Class
        </div>
        <div className="palette-hint">Drag a class, connect one to another for inheritance, or ask the assistant.</div>
      </aside>

      <div className="canvas-wrap" onDrop={onDrop} onDragOver={onDragOver}>
        <div className="canvas-toolbar">
          <button className="mini-btn" onClick={() => commit(applyMutation(spec, { op: "auto_layout", view: "classes", direction: "TB" }))}>Auto-arrange</button>
        </div>
        <ReactFlow
          nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes}
          defaultEdgeOptions={{ type: "smoothstep" }}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
          onNodeDragStop={onNodeDragStop} onNodesDelete={onNodesDelete} onEdgesDelete={onEdgesDelete}
          onNodeClick={(_e, n) => { setSelectedId(n.id); setSelectedEdgeId(null); }}
          onEdgeClick={(_e, ed) => { setSelectedEdgeId(ed.id); setSelectedId(null); }}
          onPaneClick={() => { setSelectedId(null); setSelectedEdgeId(null); }}
          fitView proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} color="#2a2d3a" />
          <Controls />
        </ReactFlow>

        {classes.length === 0 && <div className="empty-hint">Drag a class in, or ask the assistant to model your class hierarchy.</div>}

        {selected && (
          <div className="inspector wide" onClick={(e) => e.stopPropagation()}>
            <div className="insp-head">class</div>
            <label>Name</label>
            <input value={selected.name} onChange={(e) => setClass({ name: e.target.value })} />
            <label>Stereotype</label>
            <select value={selected.stereotype || ""} onChange={(e) => setClass({ stereotype: e.target.value || null })}>
              <option value="">none</option>
              <option value="abstract">abstract</option>
              <option value="interface">interface</option>
            </select>
            <div className="insp-fields-head">
              <span>Members</span>
              <span>
                <button className="mini-btn" onClick={() => commit(applyMutation(spec, { op: "add_member", view: "classes", class: selected.id, kind: "attribute", name: "field" }))}>+ attr</button>
                <button className="mini-btn" onClick={() => commit(applyMutation(spec, { op: "add_member", view: "classes", class: selected.id, kind: "method", name: "method()" }))}>+ method</button>
              </span>
            </div>
            {selected.members.map((m) => (
              <div className="field-row" key={m.id}>
                <select value={m.visibility} onChange={(e) => setMember(m.id, { visibility: e.target.value })} style={{ flex: "0 0 40px" }}>
                  {VISIBILITIES.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <input className="f-name" value={m.name} onChange={(e) => setMember(m.id, { name: e.target.value })} />
                <input value={m.type} placeholder="type" style={{ flex: "0 0 70px", minWidth: 0 }} onChange={(e) => setMember(m.id, { type: e.target.value })} />
                <button className="mini-btn ghost" onClick={() => commit(applyMutation(spec, { op: "remove_member", view: "classes", class: selected.id, member: m.id }))}>×</button>
              </div>
            ))}
          </div>
        )}

        {selectedEdge && (
          <div className="inspector" onClick={(e) => e.stopPropagation()}>
            <div className="insp-head">relation</div>
            <label>Kind</label>
            <select value={selectedEdge.kind} onChange={(e) => { let s = applyMutation(spec, { op: "disconnect_class", view: "classes", id: selectedEdge.id }); s = applyMutation(s, { op: "connect_class", view: "classes", from: selectedEdge.from, to: selectedEdge.to, kind: e.target.value }); commit(s); }}>
              {CLASS_EDGE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ClassView({ spec, commit }) {
  return <ReactFlowProvider><Inner spec={spec} commit={commit} /></ReactFlowProvider>;
}
