// The lint engine. This is what makes the canvas more than boxes-and-arrows:
// the design carries machine-checkable constraints, and every edit is checked
// against them live across all three views. A violating element lights up; the
// assistant sees the same violations and can explain or fix them.
//
// Each constraint declares a `view`. A violation references an element with a
// generic { view, nodeId?, edgeId? } so every canvas highlights uniformly:
//   architecture → nodeId=component, edgeId=wire
//   data_model   → nodeId=entity,    edgeId=relation
//   flows        → nodeId=step,      edgeId=transition

import { lintInfra } from "./infra.mjs";

const archLabel = (spec, id) => (spec.views.architecture.nodes.find((n) => n.id === id) || {}).label || id;
const entityName = (spec, id) => (spec.views.data_model.entities.find((e) => e.id === id) || {}).name || id;

// Returns { violations: [{ constraintId, view, message, nodeId?, edgeId? }] }.
export function lint(spec) {
  const violations = [];
  for (const c of spec.constraints || []) {
    const view = c.view || "architecture";
    if (view === "architecture") lintArchitecture(spec, c, violations);
    else if (view === "data_model") lintDataModel(spec, c, violations);
    else if (view === "flows") lintFlows(spec, c, violations);
    else if (view === "infra") lintInfra(spec, c, violations);
    else if (view === "cross") lintCross(spec, c, violations);
  }
  // Cross-ref integrity always runs, even without an explicit constraint.
  checkCrossRefs(spec, violations);
  return { violations };
}

function lintArchitecture(spec, c, out) {
  const { nodes, edges } = spec.views.architecture;
  const byId = (id) => nodes.find((n) => n.id === id) || {};
  const kindOf = (id) => byId(id).kind || null;
  const planeOf = (id) => byId(id).plane || "execution";
  const catOf = (id) => byId(id).category || null;
  const flagEdge = (e, msg) => out.push({ constraintId: c.id, view: "architecture", edgeId: e.id, message: c.message || msg });
  const flagNode = (n, msg) => out.push({ constraintId: c.id, view: "architecture", nodeId: n.id, message: c.message || msg });
  switch (c.rule) {
    case "forbid_edge":
      for (const e of edges)
        if (kindOf(e.from) === c.from_kind && kindOf(e.to) === c.to_kind)
          out.push({
            constraintId: c.id,
            view: "architecture",
            edgeId: e.id,
            message: c.message || `${archLabel(spec, e.from)} → ${archLabel(spec, e.to)} is forbidden.`,
          });
      break;
    case "edge_requires_protocol":
      for (const e of edges)
        if (!e.protocol)
          out.push({
            constraintId: c.id,
            view: "architecture",
            edgeId: e.id,
            message: c.message || `${archLabel(spec, e.from)} → ${archLabel(spec, e.to)} has no protocol.`,
          });
      break;
    case "require_node_kind":
      if (!nodes.some((n) => n.kind === c.kind))
        out.push({ constraintId: c.id, view: "architecture", message: c.message || `Design must include a ${c.kind}.` });
      break;

    // ---- planes (control vs execution vs data) ----
    case "plane_separation":
      // Execution must not reach the control plane except through a gateway.
      for (const e of edges)
        if (planeOf(e.from) === "execution" && planeOf(e.to) === "control" && kindOf(e.to) !== "gateway")
          flagEdge(e, `${archLabel(spec, e.from)} → ${archLabel(spec, e.to)} crosses into the control plane directly — route through a gateway.`);
      break;

    // ---- boundary / governance ----
    case "external_through_gateway":
      for (const e of edges)
        if ((catOf(e.from) === "edge" || kindOf(e.from) === "client") && kindOf(e.to) !== "gateway")
          flagEdge(e, `External traffic into ${archLabel(spec, e.to)} should cross a gateway / semantic gateway.`);
      break;
    case "rbac_on_control":
      for (const e of edges)
        if (planeOf(e.to) === "control" && !e.required_role)
          flagEdge(e, `${archLabel(spec, e.from)} → ${archLabel(spec, e.to)} mutates the control plane without a required role (RBAC).`);
      break;

    // ---- observability ----
    case "edge_requires_trace":
      for (const e of edges)
        if (planeOf(e.from) !== "data" && planeOf(e.to) !== "data" && !e.instrumented)
          flagEdge(e, `${archLabel(spec, e.from)} → ${archLabel(spec, e.to)} is not OTel-instrumented.`);
      break;

    // ---- data dependencies ----
    case "vector_db_needs_embedder":
      for (const n of nodes)
        if (n.type === "vector_db" && !edges.some((e) => e.to === n.id))
          flagNode(n, `Vector DB "${n.label}" has no upstream writer (who embeds + upserts?).`);
      break;

    default:
      break;
  }
}

function lintDataModel(spec, c, out) {
  const { entities, relations } = spec.views.data_model;
  const hasEntity = (id) => entities.some((e) => e.id === id);
  switch (c.rule) {
    case "entity_requires_pk":
      for (const e of entities)
        if (!e.fields.some((f) => f.pk))
          out.push({
            constraintId: c.id,
            view: "data_model",
            nodeId: e.id,
            message: c.message || `Entity "${e.name}" has no primary key.`,
          });
      break;
    case "fk_references_existing_entity":
      for (const e of entities)
        for (const f of e.fields)
          if (f.fk && !hasEntity(f.fk.entity))
            out.push({
              constraintId: c.id,
              view: "data_model",
              nodeId: e.id,
              message: c.message || `"${e.name}.${f.name}" references a missing entity.`,
            });
      break;
    case "relation_endpoints_exist":
      for (const r of relations)
        if (!hasEntity(r.from) || !hasEntity(r.to))
          out.push({
            constraintId: c.id,
            view: "data_model",
            edgeId: r.id,
            message: c.message || `A relation points at a missing entity.`,
          });
      break;
    default:
      break;
  }
}

function lintFlows(spec, c, out) {
  for (const flow of spec.views.flows) {
    const outgoing = (id) => flow.transitions.filter((t) => t.from === id);
    const incoming = (id) => flow.transitions.filter((t) => t.to === id);
    switch (c.rule) {
      case "flow_has_single_start": {
        const starts = flow.nodes.filter((n) => n.type === "start");
        if (starts.length !== 1)
          out.push({ constraintId: c.id, view: "flows", message: c.message || `Flow "${flow.name}" must have exactly one start (has ${starts.length}).` });
        break;
      }
      case "flow_reaches_end":
        if (flow.nodes.length && !flow.nodes.some((n) => n.type === "end"))
          out.push({ constraintId: c.id, view: "flows", message: c.message || `Flow "${flow.name}" has no end.` });
        break;
      case "decision_has_two_plus_branches":
        for (const n of flow.nodes)
          if (n.type === "decision" && outgoing(n.id).length < 2)
            out.push({ constraintId: c.id, view: "flows", nodeId: n.id, message: c.message || `Decision "${n.label}" needs at least two branches.` });
        break;
      case "no_orphan_step":
        for (const n of flow.nodes)
          if (n.type !== "start" && incoming(n.id).length === 0 && outgoing(n.id).length === 0)
            out.push({ constraintId: c.id, view: "flows", nodeId: n.id, message: c.message || `Step "${n.label}" is disconnected.` });
        break;
      default:
        break;
    }
  }
}

function lintCross(spec, c, out) {
  // Reserved for user-authored cross-view rules; integrity check below always runs.
}

// Referential integrity for cross_refs — a dangling reference is always a bug.
function checkCrossRefs(spec, out) {
  const exists = (end) => {
    if (end.view === "architecture") return spec.views.architecture.nodes.some((n) => n.id === end.ref);
    if (end.view === "infra") return spec.views.infra.nodes.some((n) => n.id === end.ref);
    if (end.view === "classes") return spec.views.classes.nodes.some((n) => n.id === end.ref);
    if (end.view === "data_model") return spec.views.data_model.entities.some((e) => e.id === end.ref);
    if (end.view === "flows") return spec.views.flows.some((f) => f.nodes.some((s) => s.id === end.ref));
    if (end.view === "sequences") return spec.views.sequences.some((q) => (q.participants || []).some((p) => p.id === end.ref));
    return false;
  };
  for (const x of spec.cross_refs || [])
    if (!exists(x.from) || !exists(x.to))
      out.push({ constraintId: "cross_ref_targets_exist", view: x.from.view, message: `A cross-reference points at a missing element.` });
}

// View-keyed highlight index. Returns:
//   { byView: { architecture: {nodes:Set, edges:Set}, data_model: {...}, flows: {...} },
//     violations, total }
export function violationIndex(spec) {
  const { violations } = lint(spec);
  const byView = {
    architecture: { nodes: new Set(), edges: new Set() },
    data_model: { nodes: new Set(), edges: new Set() },
    flows: { nodes: new Set(), edges: new Set() },
    infra: { nodes: new Set(), edges: new Set() },
  };
  for (const v of violations) {
    const bucket = byView[v.view];
    if (!bucket) continue;
    if (v.nodeId) bucket.nodes.add(v.nodeId);
    if (v.edgeId) bucket.edges.add(v.edgeId);
  }
  return { byView, violations, total: violations.length };
}
