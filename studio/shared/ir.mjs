// The IR. One `architecture.spec.json` carrying three cross-referenced views —
// architecture (components), data model (entities), and flows (flowcharts) —
// plus the constraints that lint them and the cross_refs that tie them together.
// The canvas, the chat assistant, and the coding-agent handoff all read and
// write this single shape. One mutation path (`applyMutation`) serves drag-drop
// and the assistant alike, so the two surfaces can never diverge.

export const SPEC_VERSION = "0.3.0";

export const VIEWS = ["architecture", "data_model", "flows"];

// ---- architecture vocabulary ----------------------------------------------
export const NODE_KINDS = [
  { kind: "service", label: "Service" },
  { kind: "datastore", label: "Datastore" },
  { kind: "queue", label: "Queue / Stream" },
  { kind: "gateway", label: "Gateway / LB" },
  { kind: "client", label: "Client" },
  { kind: "external", label: "External" },
];
export const EDGE_KINDS = ["calls", "streams", "owns", "publishes", "subscribes"];
export const PROTOCOLS = ["http", "grpc", "sql", "event", "ws", "internal"];

// ---- data-model vocabulary ------------------------------------------------
export const FIELD_TYPES = ["uuid", "text", "int", "float", "bool", "timestamp", "json", "enum"];
export const CARDINALITIES = ["1:1", "1:N", "N:M"];

// ---- flow vocabulary ------------------------------------------------------
export const STEP_TYPES = ["start", "process", "decision", "end"];

// ---- cross-view vocabulary ------------------------------------------------
export const CROSS_REF_KINDS = ["owns", "reads", "writes", "realizes", "implements"];

const ARCH_KIND_SET = new Set(NODE_KINDS.map((k) => k.kind));

// Mutation ops that span views (not routed to a single view reducer).
const CROSS_CUTTING_OPS = new Set([
  "add_constraint",
  "remove_constraint",
  "add_cross_ref",
  "remove_cross_ref",
  "scaffold_subsystem",
  "set_plan_section",
]);

// A genuinely empty design. Blank-canvas-first: no seeded elements.
export function emptySpec() {
  return {
    version: SPEC_VERSION,
    decision: { id: "", title: "Untitled architecture", status: "draft" },
    domain_model: { bounded_contexts: [], core_entities: [], domain_invariants: [] },
    guardrails: { forbidden_topologies: [], required_invariants: [], allowed_agentic_use: [] },
    views: {
      architecture: { nodes: [], edges: [] },
      data_model: { entities: [], relations: [] },
      flows: [],
    },
    constraints: defaultConstraints(),
    cross_refs: [],
    plan: { sections: [] },
  };
}

export function defaultConstraints() {
  return [
    {
      id: "no-direct-client-db",
      view: "architecture",
      rule: "forbid_edge",
      from_kind: "client",
      to_kind: "datastore",
      message: "Clients must not touch a datastore directly — route through a service.",
    },
    {
      id: "cross-context-needs-protocol",
      view: "architecture",
      rule: "edge_requires_protocol",
      message: "Every edge must declare a protocol so the contract is explicit.",
    },
    {
      id: "entities-need-a-key",
      view: "data_model",
      rule: "entity_requires_pk",
      message: "Every entity needs a primary key.",
    },
  ];
}

// ---- ids -------------------------------------------------------------------
// Deterministic within a session (prefix + counter). No Date.now/Math.random,
// so the module stays pure and tests reproduce exactly.
let _seq = 0;
function nextId(prefix) {
  _seq += 1;
  return `${prefix}_${_seq}`;
}
// Test-only reset so suites don't leak counter state into each other.
export function __resetIds(n = 0) {
  _seq = n;
}

// ---- factories -------------------------------------------------------------
export function makeNode({ kind, label, tech = "", context = "", notes = "", position }) {
  if (!ARCH_KIND_SET.has(kind)) throw new Error(`unknown node kind: ${kind}`);
  return {
    id: nextId(kind),
    kind,
    label: label || defaultLabelFor(kind),
    tech,
    context,
    notes,
    position: position || { x: 0, y: 0 },
  };
}

export function makeEdge({ from, to, kind = "calls", protocol = "http", label = "" }) {
  return { id: nextId("e"), from, to, kind, protocol, label };
}

export function makeEntity({ name, context = "", position, fields = [] }) {
  return {
    id: nextId("ent"),
    name: name || "Entity",
    context,
    position: position || { x: 0, y: 0 },
    fields: fields.map((f) => makeField(f)),
  };
}

export function makeField({ name, type = "text", pk = false, fk = null, nullable = true, notes = "" }) {
  return { id: nextId("fld"), name: name || "field", type, pk, fk, nullable, notes };
}

export function makeRelation({ from, to, cardinality = "1:N", label = "", fk_field = null }) {
  return { id: nextId("rel"), from, to, cardinality, label, fk_field };
}

export function makeFlow({ name }) {
  return { id: nextId("flow"), name: name || "Flow", nodes: [], transitions: [] };
}

export function makeStep({ type = "process", label, position }) {
  if (!STEP_TYPES.includes(type)) throw new Error(`unknown step type: ${type}`);
  return { id: nextId("step"), type, label: label || type, position: position || { x: 0, y: 0 } };
}

export function makeTransition({ from, to, label = "" }) {
  return { id: nextId("t"), from, to, label };
}

export function makeCrossRef({ from, to, kind = "owns", note = "" }) {
  if (!CROSS_REF_KINDS.includes(kind)) throw new Error(`unknown cross_ref kind: ${kind}`);
  return { id: nextId("xref"), from, to, kind, note };
}

function defaultLabelFor(kind) {
  const found = NODE_KINDS.find((k) => k.kind === kind);
  return found ? found.label : kind;
}

// ---- reference resolution --------------------------------------------------
// Resolve a reference that may be an id OR a human label/name within a view.
// The assistant tends to say "the API"; the canvas speaks in ids.
export function resolve(spec, view, ref) {
  if (!ref) return null;
  const low = String(ref).toLowerCase();
  if (view === "architecture") {
    const ns = spec.views.architecture.nodes;
    return ns.find((n) => n.id === ref) || ns.find((n) => n.label.toLowerCase() === low) || null;
  }
  if (view === "data_model") {
    const es = spec.views.data_model.entities;
    return es.find((e) => e.id === ref) || es.find((e) => e.name.toLowerCase() === low) || null;
  }
  if (view === "flows") {
    const fs = spec.views.flows;
    return fs.find((f) => f.id === ref) || fs.find((f) => f.name.toLowerCase() === low) || null;
  }
  return null;
}

// Back-compat alias — the architecture canvas and handoff used resolveNode.
export function resolveNode(spec, ref) {
  return resolve(spec, "architecture", ref);
}

function resolveStep(flow, ref) {
  if (!ref) return null;
  const low = String(ref).toLowerCase();
  return flow.nodes.find((s) => s.id === ref) || flow.nodes.find((s) => s.label.toLowerCase() === low) || null;
}

// ---- the single mutation path ---------------------------------------------
// Apply one structured mutation, returning a NEW spec (no in-place edits on the
// input). Drag-drop commits and assistant tool-calls both come through here.
export function applyMutation(spec, m) {
  const next = clone(spec);
  if (CROSS_CUTTING_OPS.has(m.op)) {
    applyCrossCutting(next, m);
    return next;
  }
  const view = m.view || "architecture";
  switch (view) {
    case "architecture":
      architectureReducer(next, m);
      break;
    case "data_model":
      dataModelReducer(next, m);
      break;
    case "flows":
      flowsReducer(next, m);
      break;
    default:
      throw new Error(`unknown view "${view}" for op "${m.op}"`);
  }
  return next;
}

function architectureReducer(next, m) {
  const t = next.views.architecture;
  switch (m.op) {
    case "add_node":
      t.nodes.push(makeNode(m));
      break;
    case "update_node": {
      const node = resolve(next, "architecture", m.id || m.ref);
      if (!node) throw new Error(`update_node: no node "${m.id || m.ref}"`);
      for (const f of ["label", "tech", "context", "notes"]) if (m[f] !== undefined) node[f] = m[f];
      if (m.position) node.position = m.position;
      break;
    }
    case "remove_node": {
      const node = resolve(next, "architecture", m.id || m.ref);
      if (!node) break; // idempotent
      t.nodes = t.nodes.filter((n) => n.id !== node.id);
      t.edges = t.edges.filter((e) => e.from !== node.id && e.to !== node.id);
      pruneCrossRefs(next, "architecture", node.id);
      break;
    }
    case "connect": {
      const from = resolve(next, "architecture", m.from);
      const to = resolve(next, "architecture", m.to);
      if (!from || !to) throw new Error(`connect: unknown endpoint ${m.from} → ${m.to}`);
      t.edges.push(makeEdge({ ...m, from: from.id, to: to.id }));
      break;
    }
    case "disconnect": {
      if (m.id) {
        t.edges = t.edges.filter((e) => e.id !== m.id);
      } else {
        const from = resolve(next, "architecture", m.from);
        const to = resolve(next, "architecture", m.to);
        t.edges = t.edges.filter((e) => !(from && to && e.from === from.id && e.to === to.id));
      }
      break;
    }
    default:
      throw new Error(`unknown op "${m.op}" for view "architecture"`);
  }
}

function dataModelReducer(next, m) {
  const dm = next.views.data_model;
  switch (m.op) {
    case "add_entity":
      dm.entities.push(makeEntity(m));
      break;
    case "update_entity": {
      const e = resolve(next, "data_model", m.id || m.ref);
      if (!e) throw new Error(`update_entity: no entity "${m.id || m.ref}"`);
      for (const f of ["name", "context"]) if (m[f] !== undefined) e[f] = m[f];
      if (m.position) e.position = m.position;
      break;
    }
    case "remove_entity": {
      const e = resolve(next, "data_model", m.id || m.ref);
      if (!e) break;
      dm.entities = dm.entities.filter((x) => x.id !== e.id);
      dm.relations = dm.relations.filter((r) => r.from !== e.id && r.to !== e.id);
      // Clear FKs pointing at the removed entity.
      for (const ent of dm.entities)
        for (const fld of ent.fields) if (fld.fk && fld.fk.entity === e.id) fld.fk = null;
      pruneCrossRefs(next, "data_model", e.id);
      break;
    }
    case "add_field": {
      const e = resolve(next, "data_model", m.entity);
      if (!e) throw new Error(`add_field: no entity "${m.entity}"`);
      e.fields.push(makeField(m));
      break;
    }
    case "update_field": {
      const e = resolve(next, "data_model", m.entity);
      if (!e) throw new Error(`update_field: no entity "${m.entity}"`);
      const fld = findField(e, m.field);
      if (!fld) throw new Error(`update_field: no field "${m.field}"`);
      for (const f of ["name", "type", "pk", "fk", "nullable", "notes"]) if (m[f] !== undefined) fld[f] = m[f];
      break;
    }
    case "remove_field": {
      const e = resolve(next, "data_model", m.entity);
      if (!e) break;
      const fld = findField(e, m.field);
      if (!fld) break;
      e.fields = e.fields.filter((x) => x.id !== fld.id);
      break;
    }
    case "add_relation": {
      const from = resolve(next, "data_model", m.from);
      const to = resolve(next, "data_model", m.to);
      if (!from || !to) throw new Error(`add_relation: unknown endpoint ${m.from} → ${m.to}`);
      dm.relations.push(makeRelation({ ...m, from: from.id, to: to.id }));
      break;
    }
    case "update_relation": {
      const r = dm.relations.find((x) => x.id === m.id);
      if (!r) throw new Error(`update_relation: no relation "${m.id}"`);
      for (const f of ["cardinality", "label", "fk_field"]) if (m[f] !== undefined) r[f] = m[f];
      break;
    }
    case "remove_relation":
      dm.relations = dm.relations.filter((r) => r.id !== m.id);
      break;
    default:
      throw new Error(`unknown op "${m.op}" for view "data_model"`);
  }
}

function flowsReducer(next, m) {
  const flows = next.views.flows;
  switch (m.op) {
    case "add_flow":
      flows.push(makeFlow(m));
      break;
    case "remove_flow":
      next.views.flows = flows.filter((f) => f.id !== (m.id || (resolve(next, "flows", m.ref) || {}).id));
      break;
    case "rename_flow": {
      const f = resolve(next, "flows", m.id || m.ref);
      if (!f) throw new Error(`rename_flow: no flow "${m.id || m.ref}"`);
      f.name = m.name;
      break;
    }
    default: {
      // Step/transition ops operate inside a flow named by m.flow.
      const flow = resolve(next, "flows", m.flow);
      if (!flow) throw new Error(`${m.op}: no flow "${m.flow}"`);
      flowElementReducer(flow, next, m);
    }
  }
}

function flowElementReducer(flow, next, m) {
  switch (m.op) {
    case "add_step":
      flow.nodes.push(makeStep(m));
      break;
    case "update_step": {
      const s = resolveStep(flow, m.id || m.ref);
      if (!s) throw new Error(`update_step: no step "${m.id || m.ref}"`);
      for (const f of ["label", "type"]) if (m[f] !== undefined) s[f] = m[f];
      if (m.position) s.position = m.position;
      break;
    }
    case "remove_step": {
      const s = resolveStep(flow, m.id || m.ref);
      if (!s) break;
      flow.nodes = flow.nodes.filter((x) => x.id !== s.id);
      flow.transitions = flow.transitions.filter((t) => t.from !== s.id && t.to !== s.id);
      pruneCrossRefs(next, "flows", s.id);
      break;
    }
    case "add_transition": {
      const from = resolveStep(flow, m.from);
      const to = resolveStep(flow, m.to);
      if (!from || !to) throw new Error(`add_transition: unknown step ${m.from} → ${m.to}`);
      flow.transitions.push(makeTransition({ ...m, from: from.id, to: to.id }));
      break;
    }
    case "update_transition": {
      const t = flow.transitions.find((x) => x.id === m.id);
      if (!t) throw new Error(`update_transition: no transition "${m.id}"`);
      if (m.label !== undefined) t.label = m.label;
      break;
    }
    case "remove_transition":
      flow.transitions = flow.transitions.filter((t) => t.id !== m.id);
      break;
    default:
      throw new Error(`unknown op "${m.op}" for view "flows"`);
  }
}

function applyCrossCutting(next, m) {
  switch (m.op) {
    case "add_constraint":
      next.constraints.push({ id: m.id || nextId("c"), ...m.constraint });
      break;
    case "remove_constraint":
      next.constraints = next.constraints.filter((c) => c.id !== m.id);
      break;
    case "add_cross_ref":
      next.cross_refs.push(makeCrossRef(m));
      break;
    case "remove_cross_ref":
      next.cross_refs = next.cross_refs.filter((x) => x.id !== m.id);
      break;
    case "scaffold_subsystem":
      scaffoldSubsystem(next, m);
      break;
    case "set_plan_section": {
      // Upsert an AI-authored plan section by id (the assistant's prose).
      const sections = next.plan.sections;
      const i = sections.findIndex((s) => s.id === m.id);
      const section = { id: m.id, title: m.title || m.id, body_md: m.body_md || "", source: "ai" };
      if (i >= 0) sections[i] = section;
      else sections.push(section);
      break;
    }
    default:
      throw new Error(`unknown cross-cutting op "${m.op}"`);
  }
}

// Composite: a service + its datastore + the wire between them + a matching
// entity owned by the datastore + the cross_ref tying them together. One
// assistant tool-call, several mutations, all through the factories above.
function scaffoldSubsystem(next, m) {
  const serviceLabel = m.service || `${m.name || "New"} Service`;
  const storeLabel = m.datastore || `${m.name || "New"} Store`;
  const service = makeNode({ kind: "service", label: serviceLabel, context: m.context || "" });
  const store = makeNode({ kind: "datastore", label: storeLabel, tech: m.tech || "", context: m.context || "" });
  next.views.architecture.nodes.push(service, store);
  next.views.architecture.edges.push(makeEdge({ from: service.id, to: store.id, kind: "calls", protocol: "sql" }));
  if (m.entity) {
    const entity = makeEntity({
      name: m.entity,
      context: m.context || "",
      fields: m.fields || [{ name: "id", type: "uuid", pk: true, nullable: false }],
    });
    next.views.data_model.entities.push(entity);
    next.cross_refs.push(makeCrossRef({ from: { view: "architecture", ref: store.id }, to: { view: "data_model", ref: entity.id }, kind: "owns" }));
  }
}

// ---- helpers ---------------------------------------------------------------
function findField(entity, ref) {
  if (!ref) return null;
  const low = String(ref).toLowerCase();
  return entity.fields.find((f) => f.id === ref) || entity.fields.find((f) => f.name.toLowerCase() === low) || null;
}

// Drop cross_refs that point at an element being removed (referential integrity).
function pruneCrossRefs(next, view, id) {
  next.cross_refs = next.cross_refs.filter(
    (x) => !((x.from.view === view && x.from.ref === id) || (x.to.view === view && x.to.ref === id))
  );
}

function clone(spec) {
  return JSON.parse(JSON.stringify(spec));
}

// ---- migration -------------------------------------------------------------
// Version-dispatched, idempotent, lossless on the fields the benchmark reads
// (guardrails.{forbidden_topologies,required_invariants}, decision.selected_topology).
export function migrate(input) {
  const from = input && input.version ? input.version : "0.1.0";
  let spec = clone(input || {});
  const v = spec.version;
  if (!v || v === "0.1.0") spec = migrate01to03(spec);
  else if (v === "0.2.0") spec = migrate02to03(spec);
  spec = fillDefaults(spec);
  return { spec, changed: from !== SPEC_VERSION, from };
}

// 0.1.0 research spec: has decision/domain_model/guardrails/candidate_topologies/
// evidence but no drawn topology. Seed empty views, keep everything else verbatim
// (candidate_topologies/evidence pass through untouched).
function migrate01to03(spec) {
  spec.views = {
    architecture: { nodes: [], edges: [] },
    data_model: { entities: [], relations: [] },
    flows: [],
  };
  if (!Array.isArray(spec.constraints)) spec.constraints = defaultConstraints();
  spec.version = SPEC_VERSION;
  return spec;
}

// 0.2.0 studio MVP: top-level topology{nodes,edges} + flat constraints.
function migrate02to03(spec) {
  const topo = spec.topology || { nodes: [], edges: [] };
  spec.views = {
    architecture: { nodes: topo.nodes || [], edges: topo.edges || [] },
    data_model: { entities: [], relations: [] },
    flows: [],
  };
  delete spec.topology;
  spec.constraints = (spec.constraints || []).map((c) => (c.view ? c : { ...c, view: "architecture" }));
  // Benchmark reads guardrails — backfill from domain invariants if the MVP spec lacked it.
  if (!spec.guardrails) {
    spec.guardrails = {
      forbidden_topologies: [],
      required_invariants: spec.domain_model?.domain_invariants || [],
      allowed_agentic_use: [],
    };
  }
  spec.version = SPEC_VERSION;
  return spec;
}

// Fill any missing 0.3.0 keys so downstream code can assume the full shape.
function fillDefaults(spec) {
  spec.version = SPEC_VERSION;
  spec.decision = spec.decision || { id: "", title: "Untitled architecture", status: "draft" };
  spec.domain_model = spec.domain_model || { bounded_contexts: [], core_entities: [], domain_invariants: [] };
  spec.guardrails = spec.guardrails || { forbidden_topologies: [], required_invariants: [], allowed_agentic_use: [] };
  spec.views = spec.views || {};
  spec.views.architecture = spec.views.architecture || { nodes: [], edges: [] };
  spec.views.data_model = spec.views.data_model || { entities: [], relations: [] };
  spec.views.flows = spec.views.flows || [];
  spec.constraints = spec.constraints || defaultConstraints();
  spec.cross_refs = spec.cross_refs || [];
  spec.plan = spec.plan || { sections: [] };
  return spec;
}
