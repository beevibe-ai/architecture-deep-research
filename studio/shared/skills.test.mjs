// Skills harness — each skill expands to a coherent, lint-clean, laid-out subgraph.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, __resetIds } from "./ir.mjs";
import { lint } from "./constraints.mjs";
import { SKILLS } from "./skills.mjs";

beforeEach(() => __resetIds(0));

test("agentic_rag lays down a clean RAG subgraph (vector store has an embedder)", () => {
  const s = applyMutation(emptySpec(), { op: "apply_skill", skill: "agentic_rag", params: { vector: "Qdrant", hybrid: true } });
  const a = s.views.architecture;
  assert.ok(a.nodes.some((n) => n.type === "vector_db" && n.tech === "Qdrant"));
  assert.ok(a.nodes.some((n) => n.type === "search_index")); // hybrid
  // No vector_db_needs_embedder violation — the skill wired the retriever in.
  assert.equal(lint(s).violations.some((v) => v.constraintId === "vector-db-needs-embedder"), false);
  // Auto-laid-out: positions assigned (not all at origin).
  assert.ok(a.nodes.some((n) => n.position.x !== 0 || n.position.y !== 0));
});

test("model_serving builds a clean k8s serving stack in the infra view", () => {
  const s = applyMutation(emptySpec(), { op: "apply_skill", skill: "model_serving" });
  const inf = s.views.infra;
  assert.ok(inf.nodes.some((n) => n.type === "kserve_inference"));
  const v = lint(s).violations.map((x) => x.constraintId);
  assert.equal(v.includes("gpu-needs-pool"), false); // scheduled on the GPU pool
  assert.equal(v.includes("exposed-needs-service"), false); // fronted by a Service
  assert.equal(v.includes("keda-needs-trigger"), false); // trigger set
});

test("agent_runtime skill reuses the runtime composite", () => {
  const s = applyMutation(emptySpec(), { op: "apply_skill", skill: "agent_runtime" });
  assert.equal(s.views.architecture.nodes.filter((n) => n.parent).length, 5);
});

test("every skill builds without error and stays lint-clean from empty", () => {
  for (const skill of SKILLS) {
    const s = applyMutation(emptySpec(), { op: "apply_skill", skill: skill.id });
    const violations = lint(s).violations;
    assert.equal(violations.length, 0, `skill ${skill.id} left violations: ${violations.map((v) => v.constraintId).join(", ")}`);
  }
});
