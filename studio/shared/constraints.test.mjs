// Per-view lint tests + view-keyed violationIndex.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, resolve, __resetIds } from "./ir.mjs";
import { lint, violationIndex } from "./constraints.mjs";

beforeEach(() => __resetIds(0));

const has = (spec, constraintId) => lint(spec).violations.some((v) => v.constraintId === constraintId);

test("architecture: forbid_edge flags client → datastore", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "client", label: "Web" });
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "datastore", label: "PG" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "Web", to: "PG", protocol: "sql" });
  assert.ok(has(s, "no-direct-client-db"));
});

test("data_model: entity_requires_pk fires until a PK exists, then clears", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_entity", view: "data_model", name: "User" });
  assert.ok(has(s, "entities-need-a-key"));
  const user = resolve(s, "data_model", "User");
  s = applyMutation(s, { op: "add_field", view: "data_model", entity: "User", name: "id", pk: true });
  assert.equal(has(s, "entities-need-a-key"), false);
});

test("flows: decision_has_two_plus_branches and flow_has_single_start", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_constraint", id: "decision_has_two_plus_branches", constraint: { view: "flows", rule: "decision_has_two_plus_branches" } });
  s = applyMutation(s, { op: "add_constraint", id: "flow_has_single_start", constraint: { view: "flows", rule: "flow_has_single_start" } });
  s = applyMutation(s, { op: "add_flow", view: "flows", name: "F" });
  s = applyMutation(s, { op: "add_step", view: "flows", flow: "F", type: "decision", label: "OK?" });
  s = applyMutation(s, { op: "add_step", view: "flows", flow: "F", type: "process", label: "A" });
  s = applyMutation(s, { op: "add_transition", view: "flows", flow: "F", from: "OK?", to: "A" });
  // one branch on the decision, zero start nodes → both rules fire
  const v = lint(s).violations.map((x) => x.constraintId);
  assert.ok(v.includes("flow_has_single_start"));
  assert.ok(v.includes("decision_has_two_plus_branches"));
});

test("cross_ref integrity always runs, even without a declared constraint", () => {
  let s = emptySpec();
  // Hand-craft a dangling cross_ref (target id that doesn't exist).
  s.cross_refs.push({ id: "xref_x", from: { view: "architecture", ref: "ghost" }, to: { view: "data_model", ref: "ghost2" }, kind: "owns" });
  assert.ok(has(s, "cross_ref_targets_exist"));
});

test("violationIndex buckets highlights by view", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "client", label: "Web" });
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "datastore", label: "PG" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "Web", to: "PG", protocol: "sql" });
  s = applyMutation(s, { op: "add_entity", view: "data_model", name: "User" }); // no PK
  const idx = violationIndex(s);
  assert.ok(idx.byView.architecture.edges.size >= 1);
  assert.ok(idx.byView.data_model.nodes.size >= 1);
  assert.equal(idx.total, idx.violations.length);
});
