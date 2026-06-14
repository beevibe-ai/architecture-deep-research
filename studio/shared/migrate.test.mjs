// Migration tests. The hard contract: migrating any legacy spec up to 0.3.0
// must be lossless on the fields scripts/benchmark.mjs reads
// (guardrails.{forbidden_topologies,required_invariants}, decision.selected_topology).
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate, SPEC_VERSION } from "./ir.mjs";

// A realistic 0.1.0 research spec (shape from examples/*/architecture.spec.json).
function researchSpec01() {
  return {
    version: "0.1.0",
    decision: { id: "ret_001", title: "Retrieval topology", status: "approved", selected_topology: "deterministic_code_generation" },
    domain_model: { bounded_contexts: ["IngestionContext"], core_entities: ["Contract"], domain_invariants: ["Answers must be source-backed."] },
    guardrails: { forbidden_topologies: ["black_box_ai"], required_invariants: ["Compliance flows must be replayable."], allowed_agentic_use: ["bounded extraction"] },
    candidate_topologies: [{ name: "deterministic_code_generation", decision: "selected" }],
    evidence: [{ label: "x", url: "http://e", relevance: "high" }],
  };
}

// A 0.2.0 studio MVP spec (top-level topology, flat constraints, no guardrails).
function studioSpec02() {
  return {
    version: "0.2.0",
    decision: { id: "", title: "My design", status: "draft" },
    domain_model: { bounded_contexts: [], core_entities: [], domain_invariants: ["Must validate input."] },
    topology: {
      nodes: [{ id: "service_1", kind: "service", label: "API", tech: "Express", context: "", notes: "", position: { x: 0, y: 0 } }],
      edges: [{ id: "e_2", from: "service_1", to: "service_1", kind: "calls", protocol: "http", label: "" }],
    },
    constraints: [{ id: "no-direct-client-db", rule: "forbid_edge", from_kind: "client", to_kind: "datastore", message: "no" }],
  };
}

test("0.1.0 research spec migrates to 0.3.0 and preserves benchmark fields", () => {
  const { spec, changed, from } = migrate(researchSpec01());
  assert.equal(from, "0.1.0");
  assert.equal(changed, true);
  assert.equal(spec.version, SPEC_VERSION);
  // Benchmark contract — must survive verbatim:
  assert.deepEqual(spec.guardrails.forbidden_topologies, ["black_box_ai"]);
  assert.deepEqual(spec.guardrails.required_invariants, ["Compliance flows must be replayable."]);
  assert.equal(spec.decision.selected_topology, "deterministic_code_generation");
  // Views seeded empty; research metadata passes through.
  assert.equal(spec.views.architecture.nodes.length, 0);
  assert.ok(Array.isArray(spec.candidate_topologies));
  assert.equal(spec.candidate_topologies[0].name, "deterministic_code_generation");
});

test("0.2.0 studio spec migrates topology -> views.architecture and tags constraints", () => {
  const { spec, changed, from } = migrate(studioSpec02());
  assert.equal(from, "0.2.0");
  assert.equal(changed, true);
  assert.equal(spec.topology, undefined); // moved, not duplicated
  assert.equal(spec.views.architecture.nodes.length, 1);
  assert.equal(spec.views.architecture.nodes[0].label, "API");
  assert.equal(spec.constraints[0].view, "architecture"); // back-filled
  // guardrails back-filled from domain invariants so benchmark still reads it.
  assert.deepEqual(spec.guardrails.required_invariants, ["Must validate input."]);
});

test("migration is idempotent (migrate∘migrate == migrate)", () => {
  const once = migrate(studioSpec02()).spec;
  const twice = migrate(once);
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.spec, once);
});

test("a 0.3.0 spec passes through unchanged", () => {
  const v3 = migrate(researchSpec01()).spec;
  const { changed } = migrate(v3);
  assert.equal(changed, false);
});

test("a spec with no version is treated as legacy and filled", () => {
  const { spec } = migrate({ decision: { title: "bare" } });
  assert.equal(spec.version, SPEC_VERSION);
  assert.ok(spec.views.architecture);
  assert.ok(spec.constraints.length >= 1);
});
