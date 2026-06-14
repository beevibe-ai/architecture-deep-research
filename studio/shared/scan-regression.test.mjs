// Regression tests for the bugs found dogfooding Scan-repo on a real monorepo
// (beevibe): false "missing cross-reference" lint on infra targets, and nested
// infra/arch nodes piling up at (0,0) because layout only touched the top level.
// Real specs built through applyMutation; no mocks.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, makeCrossRef, __resetIds } from "./ir.mjs";
import { lint } from "./constraints.mjs";

beforeEach(() => __resetIds(0));

// A small architecture like the one inferred from a repo: a few services + a DB.
function repoLikeArch() {
  let s = emptySpec();
  for (const label of ["API", "Core", "Daemon"]) s = applyMutation(s, { op: "add_node", view: "architecture", type: "service", label });
  s = applyMutation(s, { op: "add_node", view: "architecture", type: "relational_db", label: "DB", tech: "Postgres" });
  return s;
}

test("deployed_as cross_ref to an infra node is NOT flagged as dangling", () => {
  let s = repoLikeArch();
  s = applyMutation(s, { op: "derive", view: "infra" }); // creates deployed_as cross_refs → infra
  assert.ok((s.cross_refs || []).some((x) => x.kind === "deployed_as" && x.to.view === "infra"));
  const dangling = lint(s).violations.filter((v) => v.constraintId === "cross_ref_targets_exist");
  assert.equal(dangling.length, 0, "infra-targeted cross_refs must resolve");
});

test("a genuinely dangling cross_ref is still caught", () => {
  let s = repoLikeArch();
  s.cross_refs.push(makeCrossRef({ from: { view: "architecture", ref: "service_1" }, to: { view: "infra", ref: "inf_does_not_exist" }, kind: "deployed_as" }));
  const dangling = lint(s).violations.filter((v) => v.constraintId === "cross_ref_targets_exist");
  assert.equal(dangling.length, 1);
});

test("derive infra stores parent as an id (not a label) so nodes nest", () => {
  let s = repoLikeArch();
  s = applyMutation(s, { op: "derive", view: "infra" });
  const inf = s.views.infra;
  const ids = new Set(inf.nodes.map((n) => n.id));
  for (const n of inf.nodes) {
    if (n.parent) assert.ok(ids.has(n.parent), `parent ${n.parent} of ${n.label} must be a node id`);
  }
});

test("derived infra is laid out — no pile-up of nested nodes at (0,0)", () => {
  let s = repoLikeArch();
  s = applyMutation(s, { op: "derive", view: "infra" });
  const atOrigin = s.views.infra.nodes.filter((n) => (n.position?.x ?? 0) === 0 && (n.position?.y ?? 0) === 0);
  assert.ok(atOrigin.length <= 1, `at most one node at origin, got ${atOrigin.length}: ${atOrigin.map((n) => n.label)}`);
});

test("containers are sized to fit their children", () => {
  let s = repoLikeArch();
  s = applyMutation(s, { op: "derive", view: "infra" });
  const containers = s.views.infra.nodes.filter((n) => s.views.infra.nodes.some((c) => c.parent === n.id));
  assert.ok(containers.length > 0);
  for (const c of containers) {
    assert.ok(c.size && c.size.w > 0 && c.size.h > 0, `${c.label} should have a computed size`);
  }
});

test("auto_layout positions a runtime's nested internals (architecture)", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "scaffold_runtime", label: "Agent Runtime" }); // container + 5 internals
  s = applyMutation(s, { op: "auto_layout", view: "architecture" });
  const internals = s.views.architecture.nodes.filter((n) => n.parent);
  const distinct = new Set(internals.map((n) => `${n.position.x},${n.position.y}`));
  assert.equal(distinct.size, internals.length, "internals must not share a position");
});
