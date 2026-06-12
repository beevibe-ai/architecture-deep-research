import test from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation } from "./ir.mjs";
import { composeArchitectureView } from "./composer.mjs";

test("composed architecture groups nodes into purposeful zones", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "client", label: "Web Client" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "gateway", label: "API Gateway" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "service", label: "API Service" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "relational_db", label: "Postgres" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "Web Client", to: "API Gateway", protocol: "http" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "API Gateway", to: "API Service", protocol: "http" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "API Service", to: "Postgres", protocol: "sql" });

  const composed = composeArchitectureView(s);
  assert.deepEqual(composed.zones.map((z) => z.id), ["access", "control", "capabilities", "knowledge"]);
  for (const node of s.views.architecture.nodes) {
    assert.ok(composed.nodes.has(node.id), `${node.label} has a composed position`);
  }
  const web = s.views.architecture.nodes.find((n) => n.label === "Web Client");
  const db = s.views.architecture.nodes.find((n) => n.label === "Postgres");
  assert.ok(composed.nodes.get(web.id).position.y < composed.nodes.get(db.id).position.y);
});

test("composed architecture renders an empty container as a compact card", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "agent_runtime", label: "Agent Runtime" });
  const runtime = s.views.architecture.nodes[0];
  const composed = composeArchitectureView(s);
  const layout = composed.nodes.get(runtime.id);
  assert.equal(layout.forceLeaf, true);
  assert.equal(layout.role, "leaf");
  assert.ok(layout.size.w <= 220);
});

test("composed architecture sizes a container around its children", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "scaffold_runtime" });
  const runtime = s.views.architecture.nodes.find((n) => n.type === "agent_runtime");
  const children = s.views.architecture.nodes.filter((n) => n.parent === runtime.id);
  const composed = composeArchitectureView(s);
  const layout = composed.nodes.get(runtime.id);
  assert.equal(layout.role, "group");
  assert.ok(layout.size.w >= 320);
  assert.ok(layout.size.h >= 150);
  for (const child of children) {
    const childLayout = composed.nodes.get(child.id);
    assert.equal(childLayout.role, "child");
    assert.ok(childLayout.position.x >= 0);
    assert.ok(childLayout.position.y >= 0);
  }
});
