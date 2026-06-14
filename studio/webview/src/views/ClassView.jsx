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
const OVERVIEW_LIMIT = 24;
const GRID_COLS = 4;
const GRID_X = 260;
const GRID_Y = 170;
const GRID_POS = { x: 60, y: 80 };

function classRank(classes, edges) {
  const degree = new Map();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  return [...classes].sort((a, b) => {
    const ar = (degree.get(a.id) || 0) * 20 + (a.members?.length || 0) + (a.stereotype === "interface" ? -2 : 0);
    const br = (degree.get(b.id) || 0) * 20 + (b.members?.length || 0) + (b.stereotype === "interface" ? -2 : 0);
    return br - ar || a.name.localeCompare(b.name);
  });
}

function overviewPosition(i) {
  return {
    x: GRID_POS.x + (i % GRID_COLS) * GRID_X,
    y: GRID_POS.y + Math.floor(i / GRID_COLS) * GRID_Y,
  };
}

function Inner({ spec, commit }) {
  const classes = spec.views.classes.nodes;
  const edges = spec.views.classes.edges;
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [mode, setMode] = useState("overview"); // "overview" | "all"
  const { screenToFlowPosition, fitView } = useReactFlow();
  const overview = mode === "overview" && classes.length > OVERVIEW_LIMIT;
  const rankedClasses = useMemo(() => classRank(classes, edges), [classes, edges]);
  const shownClasses = useMemo(
    () => (overview ? rankedClasses.slice(0, OVERVIEW_LIMIT) : classes),
    [overview, rankedClasses, classes]
  );
  const shownIds = useMemo(() => new Set(shownClasses.map((c) => c.id)), [shownClasses]);
  const shownEdges = useMemo(() => edges.filter((e) => shownIds.has(e.from) && shownIds.has(e.to)), [edges, shownIds]);

  useEffect(() => {
    if (selectedId && !shownIds.has(selectedId)) setSelectedId(null);
    if (selectedEdgeId && !shownEdges.some((e) => e.id === selectedEdgeId)) setSelectedEdgeId(null);
  }, [selectedId, selectedEdgeId, shownIds, shownEdges]);

  useEffect(() => {
    setRfNodes(shownClasses.map((c, i) => ({
      id: c.id,
      type: "uml",
      position: overview ? overviewPosition(i) : c.position || { x: 0, y: 0 },
      data: { node: c },
      selected: c.id === selectedId,
    })));
    setRfEdges(shownEdges.map((e) => ({
      id: e.id, source: e.from, target: e.to, label: e.kind,
      // Inheritance points to the parent with a hollow triangle (Mermaid-style).
      markerEnd: { type: e.kind === "inherits" || e.kind === "implements" ? MarkerType.ArrowClosed : MarkerType.Arrow },
      className: `cl-${e.kind}`,
    })));
  }, [spec, selectedId, shownClasses, shownEdges, overview, setRfNodes, setRfEdges]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => fitView({ padding: 0.22, maxZoom: 1, duration: 160 }));
    return () => cancelAnimationFrame(raf);
  }, [fitView, mode, shownClasses.length]);

  const onConnect = useCallback((c) => {
    if (overview) return;
    commit(applyMutation(spec, { op: "connect_class", view: "classes", from: c.source, to: c.target, kind: "inherits" }));
  }, [spec, commit, overview]);
  const onNodeDragStop = useCallback((_e, n) => {
    if (!overview) commit(applyMutation(spec, { op: "update_class", view: "classes", id: n.id, position: n.position }));
  }, [spec, commit, overview]);
  const onNodesDelete = useCallback((dl) => { let s = spec; for (const d of dl) s = applyMutation(s, { op: "remove_class", view: "classes", ref: d.id }); setSelectedId(null); commit(s); }, [spec, commit]);
  const onEdgesDelete = useCallback((dl) => { let s = spec; for (const d of dl) s = applyMutation(s, { op: "disconnect_class", view: "classes", id: d.id }); commit(s); }, [spec, commit]);
  const onDrop = useCallback((event) => {
    event.preventDefault();
    if (overview) return;
    if (event.dataTransfer.getData("application/adr-class") !== "1") return;
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    commit(applyMutation(spec, { op: "add_class", view: "classes", name: "NewClass", position, members: [{ kind: "attribute", name: "field", type: "string" }] }));
  }, [spec, commit, screenToFlowPosition, overview]);
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
          {classes.length > OVERVIEW_LIMIT && (
            <div className="seg" title="Choose how many extracted classes are shown on the canvas">
              <button className={`seg-btn ${mode === "overview" ? "on" : ""}`} onClick={() => setMode("overview")}>Overview</button>
              <button className={`seg-btn ${mode === "all" ? "on" : ""}`} onClick={() => setMode("all")}>All</button>
            </div>
          )}
          {classes.length > OVERVIEW_LIMIT && <span className="mini-meta">{shownClasses.length}/{classes.length}</span>}
          <button className="mini-btn" onClick={() => commit(applyMutation(spec, { op: "derive", view: "classes" }))}>Sync from architecture</button>
          <button className="mini-btn" onClick={() => commit(applyMutation(spec, { op: "auto_layout", view: "classes", direction: "TB" }))}>Auto-arrange</button>
        </div>
        <ReactFlow
          nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes}
          defaultEdgeOptions={{ type: "smoothstep" }}
          deleteKeyCode={["Backspace", "Delete"]}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
          onNodeDragStop={onNodeDragStop} onNodesDelete={onNodesDelete} onEdgesDelete={onEdgesDelete}
          onNodeClick={(_e, n) => { setSelectedId(n.id); setSelectedEdgeId(null); }}
          onEdgeClick={(_e, ed) => { setSelectedEdgeId(ed.id); setSelectedId(null); }}
          onPaneClick={() => { setSelectedId(null); setSelectedEdgeId(null); }}
          fitView fitViewOptions={{ padding: 0.22, maxZoom: 1 }}
          minZoom={0.16}
          nodesDraggable={!overview}
          nodesConnectable={!overview}
          nodesDeletable={!overview}
          edgesDeletable={!overview}
          proOptions={{ hideAttribution: true }}
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
            <button className="mini-btn danger" onClick={() => { commit(applyMutation(spec, { op: "remove_class", view: "classes", id: selected.id })); setSelectedId(null); }}>Delete class</button>
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
