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
import { applyMutation, FIELD_TYPES } from "../../../shared/ir.mjs";
import { violationIndex } from "../../../shared/constraints.mjs";

const nodeTypes = { entity: EntityNode };
let elkPromise = null;
const OVERVIEW_LIMIT = 12;
const FOCUS_LIMIT = 14;
const ENTITY_WIDTH = 190;
const ENTITY_BASE_HEIGHT = 42;
const FIELD_ROW_HEIGHT = 22;
const MIN_ENTITY_HEIGHT = 76;

const ELK_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.spacing.nodeNode": "60",
  "elk.layered.spacing.nodeNodeBetweenLayers": "110",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.separateConnectedComponents": "true",
};

async function getElk() {
  if (!elkPromise) {
    elkPromise = import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK());
  }
  return elkPromise;
}

function entityHeight(entity) {
  const fieldCount = Math.max(1, entity.fields?.length || 0);
  return Math.max(MIN_ENTITY_HEIGHT, ENTITY_BASE_HEIGHT + fieldCount * FIELD_ROW_HEIGHT);
}

function degreeMap(relations) {
  const degree = new Map();
  for (const r of relations) {
    degree.set(r.from, (degree.get(r.from) || 0) + 1);
    degree.set(r.to, (degree.get(r.to) || 0) + 1);
  }
  return degree;
}

function rankEntities(entities, relations) {
  const degree = degreeMap(relations);
  return [...entities].sort((a, b) => {
    const ar = (degree.get(a.id) || 0) * 25 + (a.fields?.length || 0);
    const br = (degree.get(b.id) || 0) * 25 + (b.fields?.length || 0);
    return br - ar || a.name.localeCompare(b.name);
  });
}

function focusEntityIds(focusId, rankedEntities, relations) {
  if (!focusId) return new Set();
  const peerIds = new Set();
  for (const r of relations) {
    if (r.from === focusId) peerIds.add(r.to);
    if (r.to === focusId) peerIds.add(r.from);
  }
  const ids = new Set([focusId]);
  for (const entity of rankedEntities) {
    if (ids.size >= FOCUS_LIMIT) break;
    if (peerIds.has(entity.id)) ids.add(entity.id);
  }
  return ids;
}

async function computeElkPositions(entities, relations, options = {}) {
  const elk = await getElk();
  const graph = {
    id: "data-model",
    layoutOptions: { ...ELK_OPTIONS, ...options },
    children: entities.map((entity) => ({
      id: entity.id,
      width: ENTITY_WIDTH,
      height: entityHeight(entity),
    })),
    edges: relations.map((relation) => ({
      id: relation.id,
      sources: [relation.from],
      targets: [relation.to],
    })),
  };
  const layouted = await elk.layout(graph);
  return new Map((layouted.children || []).map((node) => [node.id, { x: node.x || 0, y: node.y || 0 }]));
}

function Inner({ spec, commit }) {
  const vIndex = useMemo(() => violationIndex(spec).byView.data_model, [spec]);
  const entities = spec.views.data_model.entities;
  const relations = spec.views.data_model.relations;
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("overview"); // "overview" | "focus" | "all" | "edit"
  const [layoutPositions, setLayoutPositions] = useState(new Map());
  const [layoutVersion, setLayoutVersion] = useState(0);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const largeDiagram = entities.length > OVERVIEW_LIMIT;
  const effectiveMode = largeDiagram ? mode : "edit";
  const editMode = effectiveMode === "edit";
  const usesComputedLayout = effectiveMode !== "edit";
  const rankedEntities = useMemo(() => rankEntities(entities, relations), [entities, relations]);
  const focusId = useMemo(
    () => (entities.some((entity) => entity.id === selectedId) ? selectedId : rankedEntities[0]?.id || null),
    [entities, rankedEntities, selectedId]
  );
  const shownEntities = useMemo(() => {
    if (effectiveMode === "edit" || effectiveMode === "all") return entities;
    const ids = effectiveMode === "focus"
      ? focusEntityIds(focusId, rankedEntities, relations)
      : new Set(rankedEntities.slice(0, OVERVIEW_LIMIT).map((entity) => entity.id));
    return entities.filter((entity) => ids.has(entity.id));
  }, [effectiveMode, entities, focusId, rankedEntities, relations]);
  const shownIds = useMemo(() => new Set(shownEntities.map((entity) => entity.id)), [shownEntities]);
  const shownRelations = useMemo(
    () => relations.filter((relation) => shownIds.has(relation.from) && shownIds.has(relation.to)),
    [relations, shownIds]
  );

  useEffect(() => {
    if (selectedId && !entities.some((entity) => entity.id === selectedId)) setSelectedId(null);
  }, [entities, selectedId]);

  useEffect(() => {
    if (selectedId && effectiveMode !== "focus" && !shownIds.has(selectedId)) setSelectedId(null);
  }, [effectiveMode, selectedId, shownIds]);

  useEffect(() => {
    if (!usesComputedLayout) {
      setLayoutPositions(new Map());
      setLayoutVersion((version) => version + 1);
      return;
    }

    let cancelled = false;
    const spacing = effectiveMode === "all"
      ? { "elk.spacing.nodeNode": "80", "elk.layered.spacing.nodeNodeBetweenLayers": "135" }
      : {};

    computeElkPositions(shownEntities, shownRelations, spacing)
      .then((positions) => {
        if (cancelled) return;
        setLayoutPositions(positions);
        setLayoutVersion((version) => version + 1);
      })
      .catch((error) => console.error("ELK data-model layout failed", error));

    return () => {
      cancelled = true;
    };
  }, [effectiveMode, shownEntities, shownRelations, usesComputedLayout]);

  useEffect(() => {
    setRfNodes(
      shownEntities.map((e) => ({
        id: e.id,
        type: "entity",
        position: usesComputedLayout ? layoutPositions.get(e.id) || e.position || { x: 0, y: 0 } : e.position || { x: 0, y: 0 },
        data: { entity: e, bad: vIndex.nodes.has(e.id) },
        selected: e.id === selectedId,
      }))
    );
    setRfEdges(
      shownRelations.map((r) => ({
        id: r.id,
        source: r.from,
        target: r.to,
        label: r.cardinality,
        className: vIndex.edges.has(r.id) ? "edge-bad" : "edge-ok",
      }))
    );
  }, [spec, vIndex, selectedId, shownEntities, shownRelations, usesComputedLayout, layoutPositions, setRfNodes, setRfEdges]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => fitView({ padding: 0.24, maxZoom: 1, duration: 160 }));
    return () => cancelAnimationFrame(raf);
  }, [fitView, effectiveMode, shownEntities.length, shownRelations.length, layoutVersion]);

  const onConnect = useCallback(
    (c) => {
      if (!editMode) return;
      commit(applyMutation(spec, { op: "add_relation", view: "data_model", from: c.source, to: c.target, cardinality: "1:N" }));
    },
    [spec, commit, editMode]
  );
  const onNodeDragStop = useCallback(
    (_e, node) => {
      if (editMode) commit(applyMutation(spec, { op: "update_entity", view: "data_model", id: node.id, position: node.position }));
    },
    [spec, commit, editMode]
  );
  const onNodesDelete = useCallback(
    (deleted) => {
      if (!editMode) return;
      let s = spec;
      for (const d of deleted) s = applyMutation(s, { op: "remove_entity", view: "data_model", ref: d.id });
      setSelectedId(null);
      commit(s);
    },
    [spec, commit, editMode]
  );
  const onEdgesDelete = useCallback(
    (deleted) => {
      if (!editMode) return;
      let s = spec;
      for (const d of deleted) s = applyMutation(s, { op: "remove_relation", view: "data_model", id: d.id });
      commit(s);
    },
    [spec, commit, editMode]
  );
  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      if (!editMode) return;
      if (event.dataTransfer.getData("application/adr-entity") !== "1") return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      commit(applyMutation(spec, { op: "add_entity", view: "data_model", name: "Entity", position, fields: [{ name: "id", type: "uuid", pk: true, nullable: false }] }));
    },
    [spec, commit, screenToFlowPosition, editMode]
  );
  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = editMode ? "move" : "none";
  }, [editMode]);
  const onAutoArrange = useCallback(async () => {
    const positions = await computeElkPositions(entities, relations, {
      "elk.spacing.nodeNode": "80",
      "elk.layered.spacing.nodeNodeBetweenLayers": "135",
    });
    let s = spec;
    for (const entity of entities) {
      const position = positions.get(entity.id);
      if (position) s = applyMutation(s, { op: "update_entity", view: "data_model", id: entity.id, position });
    }
    commit(s);
  }, [spec, commit, entities, relations]);

  const selected = shownEntities.find((e) => e.id === selectedId) || null;
  const mutate = (m) => commit(applyMutation(spec, m));
  const focusEntity = entities.find((entity) => entity.id === focusId) || null;

  return (
    <div className="view-area">
      <aside className="palette">
        <div className="palette-head">Entities</div>
        <div
          className={`chip chip-datastore ${editMode ? "" : "disabled"}`}
          draggable={editMode}
          onDragStart={(e) => {
            if (!editMode) return;
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
          {largeDiagram && (
            <div className="seg" title="Choose how much of the extracted data model is shown">
              <button className={`seg-btn ${effectiveMode === "overview" ? "on" : ""}`} onClick={() => setMode("overview")}>Overview</button>
              <button className={`seg-btn ${effectiveMode === "focus" ? "on" : ""}`} onClick={() => setMode("focus")}>Focus</button>
              <button className={`seg-btn ${effectiveMode === "all" ? "on" : ""}`} onClick={() => setMode("all")}>All</button>
              <button className={`seg-btn ${effectiveMode === "edit" ? "on" : ""}`} onClick={() => setMode("edit")}>Edit</button>
            </div>
          )}
          {largeDiagram && <span className="mini-meta">{shownEntities.length}/{entities.length}</span>}
          {effectiveMode === "focus" && focusEntity && <span className="mini-meta">{focusEntity.name}</span>}
          <button className="mini-btn" onClick={() => commit(applyMutation(spec, { op: "derive", view: "data_model" }))}>Sync from architecture</button>
          {editMode && <button className="mini-btn" onClick={onAutoArrange}>Auto-arrange</button>}
        </div>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={{ type: "smoothstep" }}
          deleteKeyCode={["Backspace", "Delete"]}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onNodesDelete={onNodesDelete}
          onEdgesDelete={onEdgesDelete}
          onNodeClick={(_e, n) => setSelectedId(n.id)}
          onPaneClick={() => {
            if (effectiveMode !== "focus") setSelectedId(null);
          }}
          fitView
          fitViewOptions={{ padding: 0.24, maxZoom: 1 }}
          minZoom={0.08}
          nodesDraggable={editMode}
          nodesConnectable={editMode}
          nodesDeletable={editMode}
          edgesDeletable={editMode}
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
