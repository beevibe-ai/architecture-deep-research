// plan.md generator + Mermaid validator tests.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, __resetIds } from "./ir.mjs";
import { generatePlan, validateMermaid, architectureMermaid, erMermaid } from "./plan.mjs";

beforeEach(() => __resetIds(0));

test("validateMermaid accepts flowchart and erDiagram, rejects fences/headers", () => {
  assert.equal(validateMermaid("flowchart LR\n a-->b").ok, true);
  assert.equal(validateMermaid("erDiagram\n A ||--o{ B : x").ok, true);
  assert.equal(validateMermaid("```mermaid\nflowchart LR").ok, false);
  assert.equal(validateMermaid("sequenceDiagram").ok, false);
  assert.equal(validateMermaid("flowchart LR\n a[unbalanced").ok, false);
});

test("generatePlan produces a structured doc with component table + valid mermaid", () => {
  let s = emptySpec();
  s.decision.title = "Billing System";
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "service", label: "API", tech: "Express" });
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "datastore", label: "PG" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "API", to: "PG", protocol: "sql" });
  s = applyMutation(s, { op: "add_entity", view: "data_model", name: "Invoice", fields: [{ name: "id", type: "uuid", pk: true }] });

  const md = generatePlan(s);
  assert.match(md, /^# Billing System/m);
  assert.match(md, /## Components/);
  assert.match(md, /\| API \| service \| execution \| Express \|/);
  assert.match(md, /## Data model/);
  assert.match(md, /### Invoice/);
  assert.match(md, /```mermaid/);
  assert.ok(validateMermaid(architectureMermaid(s)).ok);
  assert.ok(validateMermaid(erMermaid(s)).ok);
});

test("AI prose overview is spliced in when present", () => {
  let s = emptySpec();
  s.plan.sections = [{ id: "overview", title: "Overview", source: "ai", body_md: "This system bills customers monthly." }];
  const md = generatePlan(s);
  assert.match(md, /This system bills customers monthly\./);
});

test("labels with pipes/brackets don't break tables or mermaid", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "service", label: "A|B [x]" });
  const md = generatePlan(s);
  assert.ok(validateMermaid(architectureMermaid(s)).ok); // brackets stripped
  assert.match(md, /A\\\|B/); // pipe escaped in the table
});
