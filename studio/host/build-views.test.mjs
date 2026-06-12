import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, __resetIds } from "../shared/ir.mjs";
import { lint } from "../shared/constraints.mjs";
import { buildAllViews } from "./build-views.mjs";

beforeEach(() => __resetIds(0));

function archSpec() {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "service", label: "api", tech: "express" });
  s = applyMutation(s, { op: "add_node", view: "architecture", kind: "datastore", type: "relational_db", label: "postgres", tech: "pgvector" });
  s = applyMutation(s, { op: "connect", view: "architecture", from: "api", to: "postgres", kind: "calls", protocol: "sql" });
  return s;
}

test("real infra extraction keeps deploy gaps visible instead of dropping architecture components", () => {
  const full = buildAllViews(archSpec(), {
    deploy_configs: [{
      path: "docker-compose.yml",
      platform: "docker-compose",
      content: `
services:
  postgres:
    image: pgvector/pgvector:pg16
    ports: ["5433:5432"]
    volumes: ["pg_data:/var/lib/postgresql/data"]
volumes:
  pg_data:
`,
    }],
    schema_sources: [],
    class_sources: [],
    route_sources: [],
  });

  assert.ok(full.views.infra.nodes.some((n) => n.label === "postgres" && n.type === "statefulset"));
  const gap = full.views.infra.nodes.find((n) => n.label === "api" && n.type === "deploy_gap");
  assert.ok(gap, "api should be shown as missing deploy config, not omitted");
  assert.equal(gap.props.reason, "No docker-compose/k8s resource found");
  assert.equal(lint(full).violations.filter((v) => v.constraintId === "cross_ref_targets_exist").length, 0);
});

test("buildAllViews repairs collapsed architecture positions from repo inference", () => {
  const full = buildAllViews(archSpec(), {
    deploy_configs: [],
    schema_sources: [],
    class_sources: [],
    route_sources: [],
  });

  const top = full.views.architecture.nodes.filter((n) => !n.parent);
  const distinct = new Set(top.map((n) => `${n.position.x},${n.position.y}`));
  assert.equal(distinct.size, top.length, "inferred architecture must not reload as a single pile");
});
