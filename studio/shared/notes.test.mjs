// Notes (requirements/ideas) IR ops + plan.md rendering.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, __resetIds } from "./ir.mjs";
import { generatePlan } from "./plan.mjs";

beforeEach(() => __resetIds(0));

test("add/update/remove notes", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_note", kind: "functional", title: "Search contracts", body: "Full-text + semantic" });
  assert.equal(s.notes.length, 1);
  const id = s.notes[0].id;
  s = applyMutation(s, { op: "update_note", id, priority: "must" });
  assert.equal(s.notes[0].priority, "must");
  s = applyMutation(s, { op: "remove_note", id });
  assert.equal(s.notes.length, 0);
});

test("plan.md renders requirement tables and idea/decision lists", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_note", kind: "functional", title: "Login", body: "OAuth", priority: "must" });
  s = applyMutation(s, { op: "add_note", kind: "non_functional", title: "p99 < 200ms", body: "retrieval latency", priority: "should" });
  s = applyMutation(s, { op: "add_note", kind: "idea", title: "Cache embeddings", body: "" });
  s = applyMutation(s, { op: "add_note", kind: "decision", title: "Use pgvector", body: "already on Postgres" });
  const md = generatePlan(s);
  assert.match(md, /## Functional requirements/);
  assert.match(md, /\| must \| Login \| OAuth \|/);
  assert.match(md, /## Non-functional requirements/);
  assert.match(md, /p99 < 200ms/);
  assert.match(md, /## Ideas/);
  assert.match(md, /## Decisions/);
  assert.match(md, /\*\*Use pgvector\*\*/);
});
