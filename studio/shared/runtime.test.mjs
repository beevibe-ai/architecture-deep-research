// Agent Runtime composite + architecture containment.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, resolve, __resetIds } from "./ir.mjs";
import { getType } from "./catalog.mjs";

beforeEach(() => __resetIds(0));

test("agent_runtime is a container type with the five internals", () => {
  const t = getType("agent_runtime");
  assert.equal(t.container, true);
  assert.deepEqual(t.contains, ["state_manager", "task_queue", "scheduler", "logger", "monitor"]);
});

test("scaffold_runtime builds the runtime + nested internals", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "scaffold_runtime", label: "Core Runtime" });
  const nodes = s.views.architecture.nodes;
  assert.equal(nodes.length, 6); // runtime + 5 internals
  const runtime = resolve(s, "architecture", "Core Runtime");
  const internals = nodes.filter((n) => n.parent === runtime.id);
  assert.equal(internals.length, 5);
  assert.ok(internals.some((n) => n.type === "scheduler"));
});

test("removing the runtime cascades to its internals", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "scaffold_runtime" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "vector_db", label: "Mem" }); // unrelated
  const runtime = s.views.architecture.nodes.find((n) => n.type === "agent_runtime");
  s = applyMutation(s, { op: "remove_node", view: "architecture", ref: runtime.id });
  // runtime + 5 internals gone, the unrelated vector_db survives
  assert.equal(s.views.architecture.nodes.length, 1);
  assert.equal(s.views.architecture.nodes[0].type, "vector_db");
});

test("a component can be re-parented into a container", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "agent_runtime", label: "RT" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "tool_system", label: "Tools" });
  const rt = resolve(s, "architecture", "RT");
  s = applyMutation(s, { op: "update_node", view: "architecture", id: resolve(s, "architecture", "Tools").id, parent: rt.id });
  assert.equal(resolve(s, "architecture", "Tools").parent, rt.id);
});
