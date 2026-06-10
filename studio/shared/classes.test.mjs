// UML class view: classes, members, inheritance.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, resolve, __resetIds } from "./ir.mjs";

beforeEach(() => __resetIds(0));

test("add a class with members, then a method", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_class", view: "classes", name: "AgentBase", stereotype: "abstract", members: [{ kind: "attribute", name: "model", type: "BaseChatModel" }] });
  s = applyMutation(s, { op: "add_member", view: "classes", class: "AgentBase", kind: "method", name: "ainvoke(messages)", type: "AIMessage" });
  const c = resolve(s, "classes", "AgentBase");
  assert.equal(c.stereotype, "abstract");
  assert.equal(c.members.length, 2);
  assert.ok(c.members.some((m) => m.kind === "method" && m.name.startsWith("ainvoke")));
});

test("inheritance edge + cascade on remove", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_class", view: "classes", name: "AgentBase" });
  s = applyMutation(s, { op: "add_class", view: "classes", name: "ReactAgent" });
  s = applyMutation(s, { op: "connect_class", view: "classes", from: "ReactAgent", to: "AgentBase", kind: "inherits" });
  assert.equal(s.views.classes.edges.length, 1);
  s = applyMutation(s, { op: "remove_class", view: "classes", ref: "AgentBase" });
  assert.equal(s.views.classes.nodes.length, 1);
  assert.equal(s.views.classes.edges.length, 0);
});

test("auto_layout ranks subclass below its base", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_class", view: "classes", name: "Base" });
  s = applyMutation(s, { op: "add_class", view: "classes", name: "Sub" });
  s = applyMutation(s, { op: "connect_class", view: "classes", from: "Sub", to: "Base", kind: "inherits" });
  s = applyMutation(s, { op: "auto_layout", view: "classes", direction: "TB" });
  const base = resolve(s, "classes", "Base");
  const sub = resolve(s, "classes", "Sub");
  assert.ok(sub.position.y > base.position.y);
});
