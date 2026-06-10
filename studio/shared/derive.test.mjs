// Derivation — the other views project the architecture and stay in sync.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, __resetIds } from "./ir.mjs";
import { lint } from "./constraints.mjs";

beforeEach(() => __resetIds(0));

// A small architecture to derive from.
function arch() {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "gateway", label: "Gateway" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "service", label: "API" });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "relational_db", label: "DB" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "Gateway", to: "API", protocol: "http" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "API", to: "DB", protocol: "sql" });
  return s;
}

test("derive infra: a deployment+service per component, managed DB, deployed_as links", () => {
  let s = applyMutation(arch(), { op: "derive", view: "infra" });
  const inf = s.views.infra;
  assert.ok(inf.nodes.some((n) => n.type === "cluster"));
  assert.ok(inf.nodes.some((n) => n.type === "deployment" && n.label === "API"));
  assert.ok(inf.nodes.some((n) => n.type === "managed_postgres" && n.label === "DB")); // datastore → managed
  assert.ok(inf.nodes.some((n) => n.type === "service")); // workload fronted
  // deployed_as cross_refs link architecture → infra
  assert.ok((s.cross_refs || []).some((x) => x.kind === "deployed_as"));
  // infra lint clean (service fronts the workload)
  assert.equal(lint(s).violations.some((v) => v.view === "infra"), false);
});

test("derive infra is idempotent — re-deriving adds nothing", () => {
  let s = applyMutation(arch(), { op: "derive", view: "infra" });
  const n1 = s.views.infra.nodes.length;
  s = applyMutation(s, { op: "derive", view: "infra" });
  assert.equal(s.views.infra.nodes.length, n1);
});

test("derive sequences: components become participants, wiring becomes messages", () => {
  const s = applyMutation(arch(), { op: "derive", view: "sequences" });
  const seq = s.views.sequences.find((x) => x.name === "Interactions");
  assert.ok(seq);
  assert.equal(seq.participants.length, 3); // Gateway, API, DB
  assert.equal(seq.messages.length, 2); // two edges
});

test("derive data_model: an entity owned by each datastore", () => {
  const s = applyMutation(arch(), { op: "derive", view: "data_model" });
  assert.ok(s.views.data_model.entities.some((e) => e.name === "DB"));
  assert.ok((s.cross_refs || []).some((x) => x.kind === "owns" && x.to.view === "data_model"));
});
