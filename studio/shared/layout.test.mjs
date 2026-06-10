// Auto-layout (dagre) — deterministic, assigns ranked positions per view.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, __resetIds } from "./ir.mjs";

beforeEach(() => __resetIds(0));

test("auto_layout ranks architecture nodes so an edge flows downward", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "client", label: "Web" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "service", label: "API" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "Web", to: "API", protocol: "http" });
  s = applyMutation(s, { op: "auto_layout", view: "architecture", direction: "TB" });
  const web = s.views.architecture.nodes.find((n) => n.label === "Web");
  const api = s.views.architecture.nodes.find((n) => n.label === "API");
  assert.ok(api.position.y > web.position.y, "child ranks below parent in TB layout");
});

test("auto_layout is deterministic", () => {
  let a = emptySpec();
  a = applyMutation(a, { op: "add_node", view: "architecture", type: "service", label: "A" });
  a = applyMutation(a, { op: "add_node", view: "architecture", type: "datastore", label: "B" });
  a = applyMutation(a, { op: "connect", view: "architecture", from: "A", to: "B", protocol: "sql" });
  const r1 = applyMutation(a, { op: "auto_layout", view: "architecture" });
  const r2 = applyMutation(a, { op: "auto_layout", view: "architecture" });
  assert.deepEqual(r1.views.architecture.nodes.map((n) => n.position), r2.views.architecture.nodes.map((n) => n.position));
});

test("auto_layout positions data-model and flow views too", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_entity", view: "data_model", name: "User", fields: [{ name: "id", pk: true }] });
  s = applyMutation(s, { op: "add_entity", view: "data_model", name: "Order" });
  s = applyMutation(s, { op: "add_relation", view: "data_model", from: "User", to: "Order" });
  s = applyMutation(s, { op: "auto_layout", view: "data_model", direction: "LR" });
  const user = s.views.data_model.entities.find((e) => e.name === "User");
  assert.ok(Number.isFinite(user.position.x) && Number.isFinite(user.position.y));
});
