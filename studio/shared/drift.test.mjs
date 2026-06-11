// Drift — the designed architecture checked against the one inferred from code.
// Real IR specs built through applyMutation; no mocks (matches derive.test.mjs).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, __resetIds } from "./ir.mjs";
import { diffArchitecture, driftStatusByNode } from "./drift.mjs";

beforeEach(() => __resetIds(0));

// Build an architecture view from a compact node/edge list.
function arch(nodes) {
  let s = emptySpec();
  for (const n of nodes) s = applyMutation(s, { op: "add_node", view: "architecture", ...n });
  return s.views.architecture;
}

test("identical designed and actual → in_sync, no drift", () => {
  const designed = arch([{ type: "gateway", label: "Gateway" }, { type: "service", label: "API" }]);
  __resetIds(0);
  const actual = arch([{ type: "gateway", label: "Gateway" }, { type: "service", label: "API" }]);
  const r = diffArchitecture(designed, actual);
  assert.equal(r.summary.in_sync, true);
  assert.equal(r.summary.matched, 2);
});

test("component in code but not designed → in_code_not_designed, with evidence", () => {
  const designed = arch([{ type: "service", label: "API" }]);
  __resetIds(0);
  const actual = arch([
    { type: "service", label: "API" },
    { type: "cache", label: "Redis", tech: "redis", notes: "imported in src/db/cache.ts" },
  ]);
  const r = diffArchitecture(designed, actual);
  assert.equal(r.summary.in_sync, false);
  assert.equal(r.in_code_not_designed.length, 1);
  assert.equal(r.in_code_not_designed[0].label, "Redis");
  assert.deepEqual(r.in_code_not_designed[0].evidence, ["src/db/cache.ts"]);
});

test("component designed but absent from code → designed_not_in_code (phantom)", () => {
  const designed = arch([{ type: "service", label: "API" }, { type: "service", label: "Billing" }]);
  __resetIds(0);
  const actual = arch([{ type: "service", label: "API" }]);
  const r = diffArchitecture(designed, actual);
  assert.equal(r.designed_not_in_code.length, 1);
  assert.equal(r.designed_not_in_code[0].label, "Billing");
  // and it shows up as a phantom in the per-node status map
  const status = driftStatusByNode(designed, actual);
  const billingId = designed.nodes.find((n) => n.label === "Billing").id;
  assert.equal(status[billingId], "phantom");
});

test("matched component with different tech → tech_mismatch with both techs", () => {
  const designed = arch([{ type: "relational_db", label: "Database", tech: "Postgres" }]);
  __resetIds(0);
  const actual = arch([{ type: "relational_db", label: "Database", tech: "MySQL", notes: "mysql2 in src/db.ts" }]);
  const r = diffArchitecture(designed, actual);
  assert.equal(r.tech_mismatch.length, 1);
  assert.equal(r.tech_mismatch[0].designed_tech, "Postgres");
  assert.equal(r.tech_mismatch[0].actual_tech, "MySQL");
  const status = driftStatusByNode(designed, actual);
  const dbId = designed.nodes.find((n) => n.label === "Database").id;
  assert.equal(status[dbId], "mismatch");
});

test("same tech (or one side unknown) is NOT a mismatch", () => {
  const designed = arch([{ type: "relational_db", label: "DB", tech: "Postgres" }]);
  __resetIds(0);
  const actual = arch([{ type: "relational_db", label: "DB", tech: "" }]); // inference unsure
  assert.equal(diffArchitecture(designed, actual).tech_mismatch.length, 0);
});

test("matches by type when labels differ", () => {
  const designed = arch([{ type: "vector_db", label: "Memory Store" }]);
  __resetIds(0);
  const actual = arch([{ type: "vector_db", label: "pgvector store" }]);
  const r = diffArchitecture(designed, actual);
  assert.equal(r.summary.matched, 1);
  assert.equal(r.in_code_not_designed.length, 0);
});

test("nested internals are ignored — only top-level components drift", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "scaffold_runtime", label: "Agent Runtime" }); // container + 5 internals
  const designed = s.views.architecture;
  __resetIds(0);
  let s2 = emptySpec();
  s2 = applyMutation(s2, { op: "scaffold_runtime", label: "Agent Runtime" });
  const actual = s2.views.architecture;
  const r = diffArchitecture(designed, actual);
  assert.equal(r.summary.in_sync, true); // internals don't create phantom drift
});
