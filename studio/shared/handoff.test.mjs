// buildHandoff reads the multi-view spec and emits components + wiring +
// data_model + flows for the coding agent.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, __resetIds } from "./ir.mjs";
import { buildHandoff } from "./handoff.mjs";

beforeEach(() => __resetIds(0));

test("handoff carries components, wiring, entities, and flows", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "service", label: "API", notes: "edge of the system" });
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "datastore", label: "PG" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "API", to: "PG", protocol: "sql" });
  s = applyMutation(s, { op: "add_entity", view: "data_model", name: "User", fields: [{ name: "id", pk: true }] });
  s = applyMutation(s, { op: "add_flow", view: "flows", name: "Signup" });

  const h = buildHandoff(s);
  assert.equal(h.version, "0.3.0");
  assert.equal(h.components.length, 2);
  assert.equal(h.wiring.length, 1);
  assert.equal(h.wiring[0].protocol, "sql");
  assert.equal(h.data_model.entities.length, 1);
  assert.equal(h.data_model.entities[0].fields[0].pk, true);
  assert.equal(h.flows.length, 1);
  assert.equal(h.design_check_summary.component_count, 2);
  // The service's intent (notes) is carried through for the agent to read.
  assert.equal(h.components.find((c) => c.label === "API").intent, "edge of the system");
});

test("handoff reports clean=false when a constraint is violated", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "client", label: "Web" });
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "datastore", label: "PG" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "Web", to: "PG", protocol: "sql" });
  const h = buildHandoff(s);
  assert.equal(h.design_check_summary.clean, false);
  assert.ok(h.design_check_summary.violation_count >= 1);
});
