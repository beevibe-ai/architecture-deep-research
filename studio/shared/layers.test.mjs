// Layer derivation for the big-picture layered layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { layerForNode, LAYERS } from "./catalog.mjs";

test("components derive a sensible layer from type/category", () => {
  assert.equal(layerForNode({ type: "orchestrator", category: "agent_harness" }), "orchestration");
  assert.equal(layerForNode({ type: "tool_system", category: "agent_harness" }), "capabilities");
  assert.equal(layerForNode({ type: "llm_provider", category: "edge" }), "model");
  assert.equal(layerForNode({ type: "vector_db", category: "data" }), "knowledge");
  assert.equal(layerForNode({ type: "working_memory", category: "memory" }), "memory");
  assert.equal(layerForNode({ type: "client", category: "edge" }), "clients");
  assert.equal(layerForNode({ type: "otel_collector", category: "observability" }), "infrastructure");
});

test("an explicit node.layer overrides the derivation", () => {
  assert.equal(layerForNode({ type: "vector_db", category: "data", layer: "tools" }), "tools");
});

test("every derived layer is a real layer id", () => {
  const ids = new Set(LAYERS.map((l) => l.id));
  for (const t of ["orchestrator", "tool_system", "llm_provider", "vector_db", "client", "audit_log"])
    assert.ok(ids.has(layerForNode({ type: t, category: "compute" })));
});
