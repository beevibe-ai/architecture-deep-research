// Compile a design into the execution handoff coding agents consume. This is
// the bridge between the canvas and the existing adr pipeline: the same
// execution-handoff.json shape adr decide already emits, built from what the
// user drew instead of from a research run.

import { lint } from "./constraints.mjs";

export function buildHandoff(spec) {
  const { violations } = lint(spec);
  const t = spec.topology || { nodes: [], edges: [] };

  return {
    version: "0.2.0",
    decision_id: spec.decision?.id || "design_draft",
    handoff_boundary: "adr_stops_at_execution_handoff",
    source: "studio_canvas",
    artifacts: { architecture_spec: "architecture.spec.json" },
    agent_targets: [
      "claude_code_workspace_rules",
      "cursor_workspace_rules",
      "codex_workspace_rules",
    ],
    components: t.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      tech: n.tech || null,
      context: n.context || null,
      intent: n.notes || null,
    })),
    wiring: t.edges.map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind,
      protocol: e.protocol,
      label: e.label || null,
    })),
    required_invariants: spec.domain_model?.domain_invariants || [],
    constraints: spec.constraints || [],
    design_check_summary: {
      node_count: t.nodes.length,
      edge_count: t.edges.length,
      violation_count: violations.length,
      clean: violations.length === 0,
    },
  };
}
