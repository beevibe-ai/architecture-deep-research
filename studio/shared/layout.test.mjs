// Auto-layout (dagre) — deterministic, assigns ranked positions per view.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, __resetIds } from "./ir.mjs";
import { hasCollapsedLayout, repairCollapsedLayouts } from "./layout.mjs";

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

test("auto_layout separates architecture layers into readable bands", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "client", label: "Web Client" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "service", label: "API Service" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "vector_db", label: "Vector Memory" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "Web Client", to: "API Service", protocol: "http" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "API Service", to: "Vector Memory", protocol: "sql" });
  s = applyMutation(s, { op: "auto_layout", view: "architecture", direction: "TB" });
  const web = s.views.architecture.nodes.find((n) => n.label === "Web Client");
  const api = s.views.architecture.nodes.find((n) => n.label === "API Service");
  const memory = s.views.architecture.nodes.find((n) => n.label === "Vector Memory");
  assert.ok(web.position.y < api.position.y, "client layer should sit above capabilities");
  assert.ok(api.position.y < memory.position.y, "capabilities should sit above knowledge");
});

test("auto_layout preserves horizontal lanes for branched architecture maps", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "client", label: "Web Client" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "service", label: "API Service" });
  s = applyMutation(s, { op: "scaffold_runtime", label: "Agent Runtime" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "mcp_server", label: "MCP Server" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "relational_db", label: "Postgres Database" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "llm_provider", label: "LLM Provider" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "Web Client", to: "API Service", protocol: "http" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "API Service", to: "Agent Runtime", protocol: "event" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "API Service", to: "Postgres Database", protocol: "sql" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "API Service", to: "LLM Provider", protocol: "http" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "Agent Runtime", to: "Postgres Database", protocol: "sql" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "Agent Runtime", to: "MCP Server", protocol: "internal" });
  s = applyMutation(s, { op: "auto_layout", view: "architecture", direction: "TB" });

  const api = s.views.architecture.nodes.find((n) => n.label === "API Service");
  const runtime = s.views.architecture.nodes.find((n) => n.label === "Agent Runtime");
  const mcp = s.views.architecture.nodes.find((n) => n.label === "MCP Server");
  const db = s.views.architecture.nodes.find((n) => n.label === "Postgres Database");
  const llm = s.views.architecture.nodes.find((n) => n.label === "LLM Provider");
  assert.equal(api.position.y, runtime.position.y, "application components should share a row");
  assert.ok(runtime.position.x > api.position.x, "runtime should sit beside the API, not below it");
  assert.ok(mcp.position.x > db.position.x, "tool adapter should keep its own lane");
  assert.ok(new Set([mcp.position.x, db.position.x, llm.position.x]).size > 1, "lower singleton layers should not collapse into one column");
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

test("repairCollapsedLayouts fixes architecture nodes stacked at the origin", () => {
  let s = emptySpec();
  for (const label of ["API", "Daemon", "Scheduler", "Postgres"]) {
    s = applyMutation(s, { op: "add_node", view: "architecture", type: "service", label, position: { x: 0, y: 0 } });
  }
  assert.equal(hasCollapsedLayout(s.views.architecture.nodes), true);
  assert.equal(repairCollapsedLayouts(s, ["architecture"]), true);
  assert.equal(hasCollapsedLayout(s.views.architecture.nodes), false);
  const distinct = new Set(s.views.architecture.nodes.map((n) => `${n.position.x},${n.position.y}`));
  assert.equal(distinct.size, s.views.architecture.nodes.length);
});
