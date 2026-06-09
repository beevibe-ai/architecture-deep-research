// Core IR + lint tests. Pure functions, no I/O — run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, resolveNode } from "./ir.mjs";
import { lint } from "./constraints.mjs";

test("empty spec has no nodes but ships default constraints", () => {
  const s = emptySpec();
  assert.equal(s.topology.nodes.length, 0);
  assert.ok(s.constraints.length >= 1);
});

test("add_node then connect builds a wired graph", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", kind: "service", label: "API" });
  s = applyMutation(s, { op: "add_node", kind: "datastore", label: "PG" });
  s = applyMutation(s, { op: "connect", from: "API", to: "PG", kind: "calls", protocol: "sql" });
  assert.equal(s.topology.nodes.length, 2);
  assert.equal(s.topology.edges.length, 1);
  const edge = s.topology.edges[0];
  assert.equal(edge.from, resolveNode(s, "API").id);
  assert.equal(edge.to, resolveNode(s, "PG").id);
});

test("remove_node is idempotent and cascades to edges", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", kind: "service", label: "API" });
  s = applyMutation(s, { op: "add_node", kind: "datastore", label: "PG" });
  s = applyMutation(s, { op: "connect", from: "API", to: "PG", protocol: "sql" });
  s = applyMutation(s, { op: "remove_node", ref: "PG" });
  s = applyMutation(s, { op: "remove_node", ref: "PG" }); // no-op second time
  assert.equal(s.topology.nodes.length, 1);
  assert.equal(s.topology.edges.length, 0);
});

test("forbid_edge constraint flags client → datastore", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", kind: "client", label: "Web" });
  s = applyMutation(s, { op: "add_node", kind: "datastore", label: "PG" });
  s = applyMutation(s, { op: "connect", from: "Web", to: "PG", protocol: "sql" });
  const { violations } = lint(s);
  assert.ok(violations.some((v) => v.constraintId === "no-direct-client-db"));
});

test("edge_requires_protocol flags a protocol-less edge", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", kind: "service", label: "A" });
  s = applyMutation(s, { op: "add_node", kind: "service", label: "B" });
  s = applyMutation(s, { op: "connect", from: "A", to: "B", protocol: "" });
  const { violations } = lint(s);
  assert.ok(violations.some((v) => v.constraintId === "cross-context-needs-protocol"));
});
