// Extractors — real repo source → real diagrams. Inputs are representative SQL /
// compose snippets (a pure-parser boundary, where small fixtures are fine).
import { test } from "node:test";
import assert from "node:assert/strict";
import { dataModelFromSql, infraFromCompose, infraFromK8s, classesFromSource } from "./extract.mjs";
import { emptySpec, applyMutation } from "../shared/ir.mjs";

function buildDataModel(sources) {
  let s = emptySpec();
  for (const m of dataModelFromSql(sources)) s = applyMutation(s, m);
  return s.views.data_model;
}
function buildInfra(muts) {
  let s = emptySpec();
  for (const m of muts) s = applyMutation(s, m);
  return s.views.infra;
}

test("CREATE TABLE → entity with typed fields and a primary key", () => {
  const dm = buildDataModel([{ path: "migrations/1_init.sql", content: `
    CREATE TABLE person (
      id    TEXT PRIMARY KEY,
      name  TEXT NOT NULL,
      email TEXT UNIQUE,
      age   INTEGER
    );` }]);
  const person = dm.entities.find((e) => e.name === "person");
  assert.ok(person);
  assert.equal(person.fields.length, 4);
  assert.equal(person.fields.find((f) => f.name === "id").pk, true);
  assert.equal(person.fields.find((f) => f.name === "age").type, "int");
  assert.equal(person.fields.find((f) => f.name === "name").nullable, false);
});

test("REFERENCES creates a parent→child 1:N relation", () => {
  const dm = buildDataModel([{ path: "m.sql", content: `
    CREATE TABLE person ( id TEXT PRIMARY KEY );
    CREATE TABLE agent ( id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES person(id) );` }]);
  assert.equal(dm.entities.length, 2);
  const rel = dm.relations.find((r) => r.label === "owner_id");
  assert.ok(rel);
  assert.equal(dm.entities.find((e) => e.id === rel.from).name, "person");
  assert.equal(dm.entities.find((e) => e.id === rel.to).name, "agent");
  assert.equal(rel.cardinality, "1:N");
});

test("CHECK/DEFAULT with nested parens and ::jsonb don't break column parsing", () => {
  const dm = buildDataModel([{ path: "m.sql", content: `
    CREATE TABLE agent (
      id             TEXT PRIMARY KEY,
      hierarchy      TEXT NOT NULL DEFAULT 'ic' CHECK (hierarchy IN ('ic','team','org')),
      runtime_config JSONB NOT NULL DEFAULT '{"a":1}'::jsonb
    );` }]);
  const agent = dm.entities.find((e) => e.name === "agent");
  assert.equal(agent.fields.length, 3);
  assert.equal(agent.fields.find((f) => f.name === "runtime_config").type, "json");
});

test("ALTER TABLE ADD COLUMN in a later migration enriches the entity", () => {
  const dm = buildDataModel([
    { path: "1.sql", content: `CREATE TABLE task ( id TEXT PRIMARY KEY );` },
    { path: "2.sql", content: `ALTER TABLE task ADD COLUMN status TEXT NOT NULL;` },
  ]);
  const task = dm.entities.find((e) => e.name === "task");
  assert.ok(task.fields.some((f) => f.name === "status"));
});

test("self-reference (a tree) resolves to a self 1:N relation", () => {
  const dm = buildDataModel([{ path: "m.sql", content: `
    CREATE TABLE agent ( id TEXT PRIMARY KEY, parent_id TEXT REFERENCES agent(id) );` }]);
  const rel = dm.relations.find((r) => r.label === "parent_id");
  assert.equal(rel.from, rel.to);
});

test("docker-compose → stateful node for a db image, with a mounted PVC", () => {
  const inf = buildInfra(infraFromCompose(`
services:
  postgres:
    image: pgvector/pgvector:pg16
    ports: ["5433:5432"]
    volumes: ["pg_data:/var/lib/postgresql/data"]
  api:
    image: beevibe/api
    depends_on: [postgres]
volumes:
  pg_data:
`, "docker-compose.yml"));
  const pg = inf.nodes.find((n) => n.label === "postgres");
  assert.equal(pg.type, "statefulset");
  assert.equal(pg.props.image, "pgvector/pgvector:pg16");
  assert.ok(inf.nodes.some((n) => n.type === "pvc" && n.label === "pg_data"));
  assert.ok(inf.edges.some((e) => e.kind === "mounts"));
  // api depends_on postgres → an edge exists between them
  assert.ok(inf.edges.some((e) => e.kind === "backs"));
  // api is a plain deployment (not a datastore image)
  assert.equal(inf.nodes.find((n) => n.label === "api").type, "deployment");
});

function buildClasses(sources) {
  let s = emptySpec();
  for (const m of classesFromSource(sources)) s = applyMutation(s, m);
  return s.views.classes;
}

test("class with methods, abstract stereotype, extends + implements edges", () => {
  const cv = buildClasses([{ path: "src/a.ts", content: `
    export interface LlmProvider { complete(req: Req): Promise<Res>; }
    export abstract class Base { abstract run(): void; }
    export class AnthropicLlmProvider extends Base implements LlmProvider {
      constructor(cfg) {}
      async complete(req) { return 1; }
      private helper() {}
    }` }]);
  const impl = cv.nodes.find((n) => n.name === "AnthropicLlmProvider");
  assert.ok(impl);
  assert.ok(impl.members.some((m) => m.name === "complete()"));
  assert.equal(cv.nodes.find((n) => n.name === "Base").stereotype, "abstract");
  assert.equal(cv.nodes.find((n) => n.name === "LlmProvider").stereotype, "interface");
  assert.ok(cv.edges.some((e) => e.kind === "inherits"));
  assert.ok(cv.edges.some((e) => e.kind === "implements"));
});

test("control-flow keywords inside methods aren't mistaken for methods", () => {
  const cv = buildClasses([{ path: "a.ts", content: `
    export class X {
      run() { if (true) { for (let i=0;i<3;i++) { while (i) {} } } return 1; }
    }` }]);
  const x = cv.nodes.find((n) => n.name === "X");
  assert.deepEqual(x.members.map((m) => m.name), ["run()"]);
});

test("k8s manifest kinds map to infra nodes", () => {
  const inf = buildInfra(infraFromK8s(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
---
apiVersion: v1
kind: Service
metadata: { name: web-svc }
`, "k8s/web.yaml"));
  assert.ok(inf.nodes.some((n) => n.type === "deployment" && n.label === "web"));
  assert.ok(inf.nodes.some((n) => n.type === "service" && n.label === "web-svc"));
});
