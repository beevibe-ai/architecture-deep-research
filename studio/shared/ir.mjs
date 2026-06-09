// The IR. One topology block that lives inside architecture.spec.json — the
// same file the execution handoff already references, so coding agents pick it
// up for free. The canvas, the chat assistant, and the handoff all read and
// write this single shape.

export const SPEC_VERSION = "0.2.0";

// Component kinds the palette offers. Each maps to a shape/color on the canvas.
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

const KIND_SET = new Set(NODE_KINDS.map((k) => k.kind));

// A genuinely empty design. Blank-canvas-first: no seeded nodes, no fake data.
// `constraints` ships with sane structural defaults the user can edit or drop.
export function emptySpec() {
  return {
    version: SPEC_VERSION,
    decision: { id: "", title: "Untitled architecture", status: "draft" },
    domain_model: { bounded_contexts: [], core_entities: [], domain_invariants: [] },
    topology: { nodes: [], edges: [] },
    constraints: defaultConstraints(),
  };
}

export function defaultConstraints() {
  return [
    {
      id: "no-direct-client-db",
      rule: "forbid_edge",
      from_kind: "client",
      to_kind: "datastore",
      message: "Clients must not touch a datastore directly — route through a service.",
    },
    {
      id: "cross-context-needs-protocol",
      rule: "edge_requires_protocol",
      message: "Every edge must declare a protocol so the contract is explicit.",
    },
  ];
}

let _seq = 0;
// Ids are deterministic-ish within a session (kind + counter). We avoid
// Math.random/Date.now so the module stays pure and testable.
function nextId(prefix) {
  _seq += 1;
  return `${prefix}_${_seq}`;
}

export function makeNode({ kind, label, tech = "", context = "", notes = "", position }) {
  if (!KIND_SET.has(kind)) throw new Error(`unknown node kind: ${kind}`);
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

function defaultLabelFor(kind) {
  const found = NODE_KINDS.find((k) => k.kind === kind);
  return found ? found.label : kind;
}

// Resolve a node reference that may be an id OR a human label (the assistant
// tends to say "the API", the canvas speaks in ids). Returns the node or null.
export function resolveNode(spec, ref) {
  if (!ref) return null;
  const nodes = spec.topology.nodes;
  return (
    nodes.find((n) => n.id === ref) ||
    nodes.find((n) => n.label.toLowerCase() === String(ref).toLowerCase()) ||
    null
  );
}

// Apply a single structured mutation, returning a NEW spec (no in-place edits).
// This is the one code path both drag-drop commits and assistant tool-calls go
// through, so the two can never diverge.
export function applyMutation(spec, m) {
  const next = structuredCloneSpec(spec);
  const t = next.topology;
  switch (m.op) {
    case "add_node":
      t.nodes.push(makeNode(m));
      break;
    case "update_node": {
      const node = resolveNode(next, m.id || m.ref);
      if (!node) throw new Error(`update_node: no node "${m.id || m.ref}"`);
      for (const f of ["label", "tech", "context", "notes"]) {
        if (m[f] !== undefined) node[f] = m[f];
      }
      if (m.position) node.position = m.position;
      break;
    }
    case "remove_node": {
      const node = resolveNode(next, m.id || m.ref);
      if (!node) break; // idempotent — removing a gone node is a no-op
      t.nodes = t.nodes.filter((n) => n.id !== node.id);
      t.edges = t.edges.filter((e) => e.from !== node.id && e.to !== node.id);
      break;
    }
    case "connect": {
      const from = resolveNode(next, m.from);
      const to = resolveNode(next, m.to);
      if (!from || !to) throw new Error(`connect: unknown endpoint ${m.from} → ${m.to}`);
      t.edges.push(makeEdge({ ...m, from: from.id, to: to.id }));
      break;
    }
    case "disconnect": {
      if (m.id) {
        t.edges = t.edges.filter((e) => e.id !== m.id);
      } else {
        const from = resolveNode(next, m.from);
        const to = resolveNode(next, m.to);
        t.edges = t.edges.filter(
          (e) => !(from && to && e.from === from.id && e.to === to.id)
        );
      }
      break;
    }
    case "add_constraint":
      next.constraints.push({ id: m.id || nextId("c"), ...m.constraint });
      break;
    default:
      throw new Error(`unknown mutation op: ${m.op}`);
  }
  return next;
}

function structuredCloneSpec(spec) {
  // Plain JSON clone — the spec is pure data, no Dates/functions.
  return JSON.parse(JSON.stringify(spec));
}
