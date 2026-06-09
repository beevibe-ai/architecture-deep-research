// Compile a design into the execution handoff coding agents consume. This is
// the bridge between the canvas and the existing adr pipeline: the same
// execution-handoff.json shape adr decide emits, built from what the user drew
// across all three views instead of from a research run.

import { lint } from "./constraints.mjs";

export function buildHandoff(spec) {
  const { violations } = lint(spec);
  const arch = spec.views.architecture;
  const dm = spec.views.data_model;
  const flows = spec.views.flows;

  return {
    version: "0.3.0",
    decision_id: spec.decision?.id || "design_draft",
    handoff_boundary: "adr_stops_at_execution_handoff",
    source: "studio_canvas",
    artifacts: { architecture_spec: "architecture.spec.json", plan: "plan.md" },
    agent_targets: ["claude_code_workspace_rules", "cursor_workspace_rules", "codex_workspace_rules"],
    components: arch.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      tech: n.tech || null,
      context: n.context || null,
      intent: n.notes || null,
    })),
    wiring: arch.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, protocol: e.protocol, label: e.label || null })),
    data_model: {
      entities: dm.entities.map((e) => ({
        id: e.id,
        name: e.name,
        context: e.context || null,
        fields: e.fields.map((f) => ({ name: f.name, type: f.type, pk: !!f.pk, fk: f.fk || null, nullable: f.nullable !== false })),
      })),
      relations: dm.relations.map((r) => ({ from: r.from, to: r.to, cardinality: r.cardinality, label: r.label || null })),
    },
    flows: flows.map((f) => ({
      id: f.id,
      name: f.name,
      steps: f.nodes.map((s) => ({ id: s.id, type: s.type, label: s.label })),
      transitions: f.transitions.map((t) => ({ from: t.from, to: t.to, label: t.label || null })),
    })),
    cross_refs: (spec.cross_refs || []).map((x) => ({ from: x.from, to: x.to, kind: x.kind, note: x.note || null })),
    required_invariants: spec.domain_model?.domain_invariants || [],
    guardrails: spec.guardrails || null,
    constraints: spec.constraints || [],
    design_check_summary: {
      component_count: arch.nodes.length,
      entity_count: dm.entities.length,
      flow_count: flows.length,
      violation_count: violations.length,
      clean: violations.length === 0,
    },
  };
}
