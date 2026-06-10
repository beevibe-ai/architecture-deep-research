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
import EntityNode from "./EntityNode.jsx";
import SkillMenu from "./SkillMenu.jsx";
import { applyMutation, FIELD_TYPES } from "../../../shared/ir.mjs";
import { violationIndex } from "../../../shared/constraints.mjs";

const nodeTypes = { entity: EntityNode };

function Inner({ spec, commit }) {
  const vIndex = useMemo(() => violationIndex(spec).byView.data_model, [spec]);
  const entities = spec.views.data_model.entities;
  const relations = spec.views.data_model.relations;
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    setRfNodes(
      entities.map((e) => ({
        id: e.id,
        type: "entity",
        position: e.position || { x: 0, y: 0 },
        data: { entity: e, bad: vIndex.nodes.has(e.id) },
        selected: e.id === selectedId,
      }))
    );
    setRfEdges(
      relations.map((r) => ({
        id: r.id,
        source: r.from,
        target: r.to,
        label: r.cardinality,
        className: vIndex.edges.has(r.id) ? "edge-bad" : "edge-ok",
      }))
    );
  }, [spec, vIndex, selectedId, entities, relations, setRfNodes, setRfEdges]);

  const onConnect = useCallback(
    (c) => commit(applyMutation(spec, { op: "add_relation", view: "data_model", from: c.source, to: c.target, cardinality: "1:N" })),
    [spec, commit]
  );
  const onNodeDragStop = useCallback(
    (_e, node) => commit(applyMutation(spec, { op: "update_entity", view: "data_model", id: node.id, position: node.position })),
    [spec, commit]
  );
  const onNodesDelete = useCallback(
    (deleted) => {
      let s = spec;
      for (const d of deleted) s = applyMutation(s, { op: "remove_entity", view: "data_model", ref: d.id });
      setSelectedId(null);
      commit(s);
    },
    [spec, commit]
  );
  const onEdgesDelete = useCallback(
    (deleted) => {
      let s = spec;
      for (const d of deleted) s = applyMutation(s, { op: "remove_relation", view: "data_model", id: d.id });
      commit(s);
    },
    [spec, commit]
  );
  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      if (event.dataTransfer.getData("application/adr-entity") !== "1") return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      commit(applyMutation(spec, { op: "add_entity", view: "data_model", name: "Entity", position, fields: [{ name: "id", type: "uuid", pk: true, nullable: false }] }));
    },
    [spec, commit, screenToFlowPosition]
  );
  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const selected = entities.find((e) => e.id === selectedId) || null;
  const mutate = (m) => commit(applyMutation(spec, m));

  return (
    <div className="view-area">
      <aside className="palette">
        <div className="palette-head">Entities</div>
        <div
          className="chip chip-datastore"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("application/adr-entity", "1");
            e.dataTransfer.effectAllowed = "move";
          }}
        >
          <span className="dot dot-datastore" />
          Entity
        </div>
        <div className="palette-hint">Drag an entity in, connect two to relate them, or ask the assistant →</div>
      </aside>

      <div className="canvas-wrap" onDrop={onDrop} onDragOver={onDragOver}>
        <div className="canvas-toolbar">
          <SkillMenu view="data_model" spec={spec} commit={commit} />
          <button className="mini-btn" onClick={() => commit(applyMutation(spec, { op: "auto_layout", view: "data_model", direction: "LR" }))}>Auto-arrange</button>
        </div>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={{ type: "smoothstep" }}
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

        {entities.length === 0 && (
          <div className="empty-hint">Drag an entity from the left, or ask the assistant to model your data.</div>
        )}

        {selected && (
          <EntityInspector spec={spec} entity={selected} mutate={mutate} commit={commit} />
        )}
      </div>
    </div>
  );
}

// Edit an entity's name, its fields, and which component owns it (a cross_ref).
function EntityInspector({ spec, entity, mutate, commit }) {
  const owners = spec.views.architecture.nodes;
  const ownerRef = (spec.cross_refs || []).find(
    (x) => x.kind === "owns" && x.to.view === "data_model" && x.to.ref === entity.id
  );

  // Owner is a cross_ref: clear any existing "owns" then add the new one.
  const setOwner = (nodeId) => {
    let s = spec;
    if (ownerRef) s = applyMutation(s, { op: "remove_cross_ref", id: ownerRef.id });
    if (nodeId) s = applyMutation(s, { op: "add_cross_ref", from: { view: "architecture", ref: nodeId }, to: { view: "data_model", ref: entity.id }, kind: "owns" });
    commit(s);
  };

  return (
    <div className="inspector wide" onClick={(e) => e.stopPropagation()}>
      <div className="insp-head">entity</div>
      <label>Name</label>
      <input value={entity.name} onChange={(e) => mutate({ op: "update_entity", view: "data_model", id: entity.id, name: e.target.value })} />

      <div className="insp-fields-head">
        <span>Fields</span>
        <button className="mini-btn" onClick={() => mutate({ op: "add_field", view: "data_model", entity: entity.id, name: "field", type: "text" })}>+ field</button>
      </div>
      {entity.fields.map((f) => (
        <div className="field-row" key={f.id}>
          <input className="f-name" value={f.name} onChange={(e) => mutate({ op: "update_field", view: "data_model", entity: entity.id, field: f.id, name: e.target.value })} />
          <select value={f.type} onChange={(e) => mutate({ op: "update_field", view: "data_model", entity: entity.id, field: f.id, type: e.target.value })}>
            {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <label className="f-pk" title="primary key">
            <input type="checkbox" checked={!!f.pk} onChange={(e) => mutate({ op: "update_field", view: "data_model", entity: entity.id, field: f.id, pk: e.target.checked })} />PK
          </label>
          <button className="mini-btn ghost" onClick={() => mutate({ op: "remove_field", view: "data_model", entity: entity.id, field: f.id })}>×</button>
        </div>
      ))}

      <label>Owned by (component)</label>
      <select value={ownerRef ? ownerRef.from.ref : ""} onChange={(e) => setOwner(e.target.value)}>
        <option value="">— none —</option>
        {owners.map((n) => <option key={n.id} value={n.id}>{n.label} ({n.kind})</option>)}
      </select>
      <button className="mini-btn danger" onClick={() => commit(applyMutation(spec, { op: "remove_entity", view: "data_model", id: entity.id }))}>Delete entity</button>
    </div>
  );
}

export default function DataModelView({ spec, commit }) {
  return (
    <ReactFlowProvider>
      <Inner spec={spec} commit={commit} />
    </ReactFlowProvider>
  );
}
