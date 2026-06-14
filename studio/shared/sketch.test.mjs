import test from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, __resetIds } from "./ir.mjs";
import { architectureSketchMermaid, extractFirstMermaid, normalizeSketchMarkdown } from "./sketch.mjs";

test("extractFirstMermaid pulls the first fenced diagram", () => {
  const block = extractFirstMermaid("Before\n```mermaid\nflowchart TD\n  A --> B\n```\nAfter");
  assert.equal(block.head, "flowchart");
  assert.match(block.source, /A --> B/);
});

test("architectureSketchMermaid mirrors the structured architecture", () => {
  __resetIds();
  let spec = emptySpec();
  spec = applyMutation(spec, { op: "add_node", view: "architecture", type: "service", label: "API" });
  spec = applyMutation(spec, { op: "add_node", view: "architecture", type: "relational_db", label: "Postgres" });
  spec = applyMutation(spec, { op: "connect", view: "architecture", from: "API", to: "Postgres", protocol: "sql" });
  const sketch = architectureSketchMermaid(spec);
  assert.match(sketch, /^flowchart TD/);
  assert.match(sketch, /API \/ service/);
  assert.match(sketch, /Postgres \/ relational_db/);
  assert.match(sketch, /sql/);
});

test("normalizeSketchMarkdown keeps LLM sketches and falls back to IR sketches", () => {
  __resetIds();
  const spec = applyMutation(emptySpec(), { op: "add_node", view: "architecture", type: "service", label: "API" });
  assert.match(normalizeSketchMarkdown("```mermaid\nflowchart TD\n  X --> Y\n```", spec), /X --> Y/);
  assert.match(normalizeSketchMarkdown("No diagram.", spec), /API \/ service/);
});
