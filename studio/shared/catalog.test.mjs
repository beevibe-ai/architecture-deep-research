// Catalog + catalog-aware node creation + new lint rules.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, makeNode, __resetIds } from "./ir.mjs";
import { getType, nodeDefaults, mergeCatalog } from "./catalog.mjs";
import { lint } from "./constraints.mjs";

beforeEach(() => __resetIds(0));

test("catalog resolves agent-native types with planes and tech", () => {
  assert.equal(getType("semantic_gateway").plane, "control");
  assert.equal(getType("vector_db").category, "data");
  assert.ok(getType("search_index").tech.includes("SQLite FTS5"));
  assert.ok(getType("vector_db").tech.includes("pgvector"));
});

test("makeNode from a catalog type fills category/plane/coarse-kind/tech", () => {
  const n = makeNode({ type: "vector_db" });
  assert.equal(n.type, "vector_db");
  assert.equal(n.category, "data");
  assert.equal(n.plane, "data");
  assert.equal(n.kind, "datastore"); // legacy lint still works
  assert.equal(n.tech, "pgvector"); // first tech as default
});

test("mergeCatalog overrides an entry and appends a new one", () => {
  const merged = mergeCatalog([
    { id: "vector_db", tech: ["pgvector", "TurboPuffer"] },
    { id: "feature_store", category: "data", label: "Feature Store", plane: "data" },
  ]);
  assert.ok(merged.find((c) => c.id === "vector_db").tech.includes("TurboPuffer"));
  assert.ok(merged.find((c) => c.id === "feature_store"));
});

test("plane_separation flags execution → control that skips a gateway", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "agent_loop", label: "Loop" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "orchestrator", label: "Orchestrator" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "Loop", to: "Orchestrator", protocol: "internal" });
  const v = lint(s).violations;
  assert.ok(v.some((x) => x.constraintId === "plane-separation"));
});

test("vector_db_needs_embedder fires until something writes to it", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "vector_db", label: "Memory" });
  assert.ok(lint(s).violations.some((x) => x.constraintId === "vector-db-needs-embedder"));
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "tool_system", label: "Tools" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "Tools", to: "Memory", protocol: "grpc" });
  assert.equal(lint(s).violations.some((x) => x.constraintId === "vector-db-needs-embedder"), false);
});

test("set_edge_semantics records delivery, consistency, RBAC, and OTel", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "service", label: "A" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "event_queue", label: "Q" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "A", to: "Q", kind: "publishes", protocol: "event" });
  s = applyMutation(s, { op: "set_edge_semantics", view: "architecture", from: "A", to: "Q", delivery: "ordered", consistency: "vector_clock", instrumented: true });
  const e = s.views.architecture.edges[0];
  assert.equal(e.delivery, "ordered");
  assert.equal(e.consistency, "vector_clock");
  assert.equal(e.instrumented, true);
});
