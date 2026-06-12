import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, __resetIds } from "./ir.mjs";
import { summarizeSpecChange } from "./change-diff.mjs";

beforeEach(() => __resetIds(0));

test("summarizeSpecChange marks added architecture components", () => {
  const before = emptySpec();
  const after = applyMutation(before, { op: "add_node", view: "architecture", type: "service", label: "API Service" });
  const api = after.views.architecture.nodes[0];

  const diff = summarizeSpecChange(before, after, "test");

  assert.equal(diff.total, 1);
  assert.equal(diff.added, 1);
  assert.equal(diff.items[0].label, "Architecture: API Service");
  assert.equal(diff.byView.architecture.nodes[api.id], "added");
});

test("summarizeSpecChange ignores layout-only movement", () => {
  let before = emptySpec();
  before = applyMutation(before, { op: "add_node", view: "architecture", type: "service", label: "API Service" });
  const api = before.views.architecture.nodes[0];
  const after = applyMutation(before, { op: "update_node", view: "architecture", id: api.id, position: { x: 320, y: 180 } });

  const diff = summarizeSpecChange(before, after, "test");

  assert.equal(diff.total, 0);
});

test("summarizeSpecChange treats stable labels with regenerated ids as unchanged", () => {
  let before = emptySpec();
  before = applyMutation(before, { op: "add_node", view: "architecture", type: "service", label: "API Service" });
  const oldApi = before.views.architecture.nodes[0];
  const after = {
    ...before,
    views: {
      ...before.views,
      architecture: {
        ...before.views.architecture,
        nodes: [{ ...oldApi, id: "service_999", position: { x: 800, y: 20 } }],
      },
    },
  };

  const diff = summarizeSpecChange(before, after, "test");

  assert.equal(diff.total, 0);
});

test("summarizeSpecChange marks semantic node and edge updates", () => {
  let before = emptySpec();
  before = applyMutation(before, { op: "add_node", view: "architecture", type: "service", label: "API Service" });
  before = applyMutation(before, { op: "add_node", view: "architecture", type: "relational_db", label: "Postgres" });
  before = applyMutation(before, { op: "connect", view: "architecture", from: "API Service", to: "Postgres", protocol: "http" });
  const api = before.views.architecture.nodes.find((n) => n.label === "API Service");
  const edge = before.views.architecture.edges[0];
  let after = applyMutation(before, { op: "update_node", view: "architecture", id: api.id, tech: "Express" });
  after = applyMutation(after, { op: "set_edge_semantics", view: "architecture", id: edge.id, protocol: "sql" });

  const diff = summarizeSpecChange(before, after, "test");

  assert.equal(diff.total, 2);
  assert.equal(diff.updated, 2);
  assert.equal(diff.byView.architecture.nodes[api.id], "updated");
  assert.equal(diff.byView.architecture.edges[edge.id], "updated");
});
