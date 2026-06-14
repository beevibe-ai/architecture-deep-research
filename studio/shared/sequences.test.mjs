// Sequence view: participants, ordered messages, reorder.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, resolve, __resetIds } from "./ir.mjs";

beforeEach(() => __resetIds(0));

function built() {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_sequence", view: "sequences", name: "Plan-Execute" });
  s = applyMutation(s, { op: "add_participant", view: "sequences", seq: "Plan-Execute", label: "User" });
  s = applyMutation(s, { op: "add_participant", view: "sequences", seq: "Plan-Execute", label: "Agent" });
  s = applyMutation(s, { op: "add_participant", view: "sequences", seq: "Plan-Execute", label: "Planner" });
  s = applyMutation(s, { op: "add_message", view: "sequences", seq: "Plan-Execute", from: "User", to: "Agent", label: "query", type: "sync" });
  s = applyMutation(s, { op: "add_message", view: "sequences", seq: "Plan-Execute", from: "Agent", to: "Planner", label: "plan", type: "sync" });
  s = applyMutation(s, { op: "add_message", view: "sequences", seq: "Plan-Execute", from: "Planner", to: "Agent", label: "steps", type: "return" });
  return s;
}

test("participants and messages resolve by label", () => {
  const s = built();
  const seq = resolve(s, "sequences", "Plan-Execute");
  assert.equal(seq.participants.length, 3);
  assert.equal(seq.messages.length, 3);
  const user = seq.participants.find((p) => p.label === "User");
  assert.equal(seq.messages[0].from, user.id); // stored as id, not label
});

test("messages reorder; removing a participant drops its messages", () => {
  let s = built();
  let seq = resolve(s, "sequences", "Plan-Execute");
  const second = seq.messages[1].id;
  s = applyMutation(s, { op: "move_message", view: "sequences", seq: "Plan-Execute", id: second, dir: "up" });
  seq = resolve(s, "sequences", "Plan-Execute");
  assert.equal(seq.messages[0].id, second); // moved to front
  s = applyMutation(s, { op: "remove_participant", view: "sequences", seq: "Plan-Execute", ref: "Planner" });
  seq = resolve(s, "sequences", "Plan-Execute");
  assert.equal(seq.participants.length, 2);
  assert.equal(seq.messages.length, 1); // two messages touched Planner
});

test("move_participant reorders columns", () => {
  let s = built();
  s = applyMutation(s, { op: "move_participant", view: "sequences", seq: "Plan-Execute", ref: "Planner", dir: "left" });
  const seq = resolve(s, "sequences", "Plan-Execute");
  assert.equal(seq.participants[1].label, "Planner");
});
