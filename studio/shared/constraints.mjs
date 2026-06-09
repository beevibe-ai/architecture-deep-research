// The lint engine. This is what makes the canvas more than boxes-and-arrows:
// the design carries machine-checkable constraints, and every edit is checked
// against them live. A violating edge lights up; the assistant can explain it.
//
// Rules are intentionally small and structural. They run in the webview (for
// instant feedback as you draw) and in the host (so the assistant sees the same
// violations the user does).

const KIND_OF = (topology, id) => {
  const n = topology.nodes.find((x) => x.id === id);
  return n ? n.kind : null;
};

const NODE_LABEL = (topology, id) => {
  const n = topology.nodes.find((x) => x.id === id);
  return n ? n.label : id;
};

// Returns { violations: [{ constraintId, message, edgeId?, nodeId? }] }.
export function lint(spec) {
  const topology = spec.topology || { nodes: [], edges: [] };
  const constraints = spec.constraints || [];
  const violations = [];

  for (const c of constraints) {
    switch (c.rule) {
      case "forbid_edge":
        for (const e of topology.edges) {
          if (KIND_OF(topology, e.from) === c.from_kind && KIND_OF(topology, e.to) === c.to_kind) {
            violations.push({
              constraintId: c.id,
              edgeId: e.id,
              message:
                c.message ||
                `${NODE_LABEL(topology, e.from)} → ${NODE_LABEL(topology, e.to)} is forbidden.`,
            });
          }
        }
        break;

      case "edge_requires_protocol":
        for (const e of topology.edges) {
          if (!e.protocol) {
            violations.push({
              constraintId: c.id,
              edgeId: e.id,
              message:
                c.message ||
                `${NODE_LABEL(topology, e.from)} → ${NODE_LABEL(topology, e.to)} has no protocol.`,
            });
          }
        }
        break;

      case "require_node_kind":
        // A design of this shape must contain at least one node of a kind.
        if (!topology.nodes.some((n) => n.kind === c.kind)) {
          violations.push({
            constraintId: c.id,
            message: c.message || `Design must include at least one ${c.kind}.`,
          });
        }
        break;

      default:
        // Unknown rule types are ignored, not fatal — constraints evolve.
        break;
    }
  }

  return { violations };
}

// Convenience: which edge/node ids are currently in violation (for highlighting).
export function violationIndex(spec) {
  const { violations } = lint(spec);
  const edges = new Set();
  const nodes = new Set();
  for (const v of violations) {
    if (v.edgeId) edges.add(v.edgeId);
    if (v.nodeId) nodes.add(v.nodeId);
  }
  return { edges, nodes, violations };
}
