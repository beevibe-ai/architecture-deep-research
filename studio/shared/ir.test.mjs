// Core IR tests — view-aware applyMutation across all three views. Pure
// functions, no I/O. Run with `node --test`.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, resolve, __resetIds } from "./ir.mjs";

beforeEach(() => __resetIds(0));

test("empty spec has the full 0.3.0 multi-view shape", () => {
  const s = emptySpec();
  assert.equal(s.version, "0.3.0");
  assert.deepEqual(Object.keys(s.views).sort(), ["architecture", "classes", "data_model", "flows", "infra", "sequences"]);
  assert.equal(s.views.architecture.nodes.length, 0);
  assert.equal(s.views.data_model.entities.length, 0);
  assert.ok(Array.isArray(s.views.flows));
  assert.ok(s.constraints.length >= 1);
  assert.ok(Array.isArray(s.cross_refs));
});

test("applyMutation returns a new spec and never mutates the input", () => {
  const s = emptySpec();
  const s2 = applyMutation(s, { op: "add_node", view: "architecture", kind: "service", label: "API" });
  assert.equal(s.views.architecture.nodes.length, 0); // input untouched
  assert.equal(s2.views.architecture.nodes.length, 1);
});

test("applyMutation seeds ids from a loaded spec before creating new elements", () => {
  let s = emptySpec();
  s.views.infra.nodes.push({ id: "inf_12", type: "service", label: "loaded", props: {}, position: { x: 0, y: 0 } });
  __resetIds(0); // simulate a fresh webview/extension process opening an existing spec
  s = applyMutation(s, { op: "add_infra", view: "infra", type: "service", label: "new" });
  assert.equal(s.views.infra.nodes.at(-1).id, "inf_13");
});

test("architecture: add + connect builds a wired graph; remove cascades to edges", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "service", label: "API" });
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "datastore", label: "PG" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "API", to: "PG", protocol: "sql" });
  assert.equal(s.views.architecture.edges.length, 1);
  s = applyMutation(s, { op: "remove_node", view: "architecture", ref: "PG" });
  assert.equal(s.views.architecture.nodes.length, 1);
  assert.equal(s.views.architecture.edges.length, 0);
});

test("architecture view is the default when no view is given (back-compat)", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", kind: "service", label: "API" });
  assert.equal(s.views.architecture.nodes.length, 1);
});

test("data_model: entity with fields, PK, and a relation", () => {
  let s = emptySpec();
  s = applyMutation(s, {
    op: "add_entity",
    view: "data_model",
    name: "User",
    fields: [{ name: "id", type: "uuid", pk: true, nullable: false }, { name: "email", type: "text" }],
  });
  s = applyMutation(s, { op: "add_entity", view: "data_model", name: "Order" });
  s = applyMutation(s, { op: "add_field", view: "data_model", entity: "Order", name: "id", type: "uuid", pk: true });
  s = applyMutation(s, { op: "add_relation", view: "data_model", from: "User", to: "Order", cardinality: "1:N" });
  const user = resolve(s, "data_model", "User");
  assert.equal(user.fields.length, 2);
  assert.ok(user.fields.some((f) => f.pk));
  assert.equal(s.views.data_model.relations.length, 1);
});

test("data_model: removing an entity drops its relations and clears dangling FKs", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_entity", view: "data_model", name: "User", fields: [{ name: "id", pk: true }] });
  s = applyMutation(s, { op: "add_entity", view: "data_model", name: "Order" });
  const user = resolve(s, "data_model", "User");
  s = applyMutation(s, { op: "add_field", view: "data_model", entity: "Order", name: "user_id", fk: { entity: user.id, field: "id" } });
  s = applyMutation(s, { op: "add_relation", view: "data_model", from: "User", to: "Order" });
  s = applyMutation(s, { op: "remove_entity", view: "data_model", ref: "User" });
  assert.equal(s.views.data_model.entities.length, 1);
  assert.equal(s.views.data_model.relations.length, 0);
  const order = resolve(s, "data_model", "Order");
  assert.equal(order.fields.find((f) => f.name === "user_id").fk, null);
});

test("flows: a flow with steps and transitions; remove_step cascades", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_flow", view: "flows", name: "Checkout" });
  s = applyMutation(s, { op: "add_step", view: "flows", flow: "Checkout", type: "start", label: "Begin" });
  s = applyMutation(s, { op: "add_step", view: "flows", flow: "Checkout", type: "process", label: "Charge" });
  s = applyMutation(s, { op: "add_step", view: "flows", flow: "Checkout", type: "end", label: "Done" });
  s = applyMutation(s, { op: "add_transition", view: "flows", flow: "Checkout", from: "Begin", to: "Charge" });
  s = applyMutation(s, { op: "add_transition", view: "flows", flow: "Checkout", from: "Charge", to: "Done" });
  let flow = resolve(s, "flows", "Checkout");
  assert.equal(flow.nodes.length, 3);
  assert.equal(flow.transitions.length, 2);
  s = applyMutation(s, { op: "remove_step", view: "flows", flow: "Checkout", ref: "Charge" });
  flow = resolve(s, "flows", "Checkout");
  assert.equal(flow.nodes.length, 2);
  assert.equal(flow.transitions.length, 0); // both transitions touched Charge
});

test("cross_refs: add, and prune when the referenced element is removed", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "datastore", label: "PG" });
  s = applyMutation(s, { op: "add_entity", view: "data_model", name: "User", fields: [{ name: "id", pk: true }] });
  const store = resolve(s, "architecture", "PG");
  const user = resolve(s, "data_model", "User");
  s = applyMutation(s, {
    op: "add_cross_ref",
    from: { view: "architecture", ref: store.id },
    to: { view: "data_model", ref: user.id },
    kind: "owns",
  });
  assert.equal(s.cross_refs.length, 1);
  s = applyMutation(s, { op: "remove_node", view: "architecture", ref: "PG" });
  assert.equal(s.cross_refs.length, 0); // pruned with the datastore
});

test("scaffold_subsystem creates service + datastore + edge + entity + cross_ref", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "scaffold_subsystem", name: "Billing", entity: "Invoice" });
  assert.equal(s.views.architecture.nodes.length, 2);
  assert.equal(s.views.architecture.edges.length, 1);
  assert.equal(s.views.data_model.entities.length, 1);
  assert.equal(s.cross_refs.length, 1);
});

test("unknown op throws (the assistant relies on this for feedback)", () => {
  const s = emptySpec();
  assert.throws(() => applyMutation(s, { op: "frobnicate", view: "architecture" }), /unknown op/);
});
