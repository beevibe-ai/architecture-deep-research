// Infrastructure view: containment, lint, and manifest compilation.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, resolve, __resetIds } from "./ir.mjs";
import { lint } from "./constraints.mjs";
import { compileManifests } from "./infra.mjs";

beforeEach(() => __resetIds(0));

function deployedApp() {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_infra", view: "infra", type: "cluster", label: "prod" });
  const cluster = resolve(s, "infra", "prod");
  s = applyMutation(s, { op: "add_infra", view: "infra", type: "namespace", label: "app-ns", parent: cluster.id, props: { name: "app" } });
  s = applyMutation(s, { op: "add_infra", view: "infra", type: "deployment", label: "API", props: { image: "ghcr.io/org/api:1.0", replicas: 3, port: 8080 } });
  return s;
}

test("infra add + containment: namespace is a child of the cluster", () => {
  const s = deployedApp();
  const ns = resolve(s, "infra", "app-ns");
  const cluster = resolve(s, "infra", "prod");
  assert.equal(ns.parent, cluster.id);
  assert.equal(s.views.infra.nodes.length, 3);
});

test("remove_infra cascades to descendants", () => {
  let s = deployedApp();
  s = applyMutation(s, { op: "remove_infra", view: "infra", ref: "prod" });
  // cluster + its namespace child both gone; the standalone deployment remains
  assert.equal(s.views.infra.nodes.length, 1);
  assert.equal(resolve(s, "infra", "API").label, "API");
});

test("exposed_needs_service fires until a Service fronts the deployment", () => {
  let s = deployedApp();
  assert.ok(lint(s).violations.some((v) => v.constraintId === "exposed-needs-service"));
  s = applyMutation(s, { op: "add_infra", view: "infra", type: "service", label: "api-svc" });
  s = applyMutation(s, { op: "connect_infra", view: "infra", from: "api-svc", to: "API", kind: "exposes" });
  assert.equal(lint(s).violations.some((v) => v.constraintId === "exposed-needs-service"), false);
});

test("compileManifests emits a Deployment with image + replicas", () => {
  const s = deployedApp();
  const files = compileManifests(s);
  const yaml = files.find((f) => f.path.endsWith("k8s.yaml")).content;
  assert.match(yaml, /kind: Deployment/);
  assert.match(yaml, /image: ghcr\.io\/org\/api:1\.0/);
  assert.match(yaml, /replicas: 3/);
  assert.match(yaml, /namespace: app/);
  assert.match(yaml, /adr\.studio\/node-id: "inf_3"/);
  assert.match(yaml, /app\.kubernetes\.io\/managed-by: "adr-studio"/);
});

test("compileManifests keeps Service selectors aligned with exposed workload labels", () => {
  let s = deployedApp();
  s = applyMutation(s, { op: "add_infra", view: "infra", type: "service", label: "api-svc", props: { port: 80, target_port: 8080 } });
  s = applyMutation(s, { op: "connect_infra", view: "infra", from: "api-svc", to: "API", kind: "exposes" });
  const yaml = compileManifests(s).find((f) => f.path.endsWith("k8s.yaml")).content;
  assert.match(yaml, /kind: Service/);
  assert.match(yaml, /selector: \{ app: api \}/);
  assert.match(yaml, /targetPort: 8080/);
});

test("managed cloud resources compile to Terraform", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_infra", view: "infra", type: "managed_postgres", label: "orders-db", props: { instance_class: "db.r6g.xlarge" } });
  s = applyMutation(s, { op: "add_infra", view: "infra", type: "dynamodb", label: "sessions" });
  const files = compileManifests(s);
  const tf = files.find((f) => f.path.endsWith("main.tf")).content;
  assert.match(tf, /resource "aws_db_instance"/);
  assert.match(tf, /db\.r6g\.xlarge/);
  assert.match(tf, /resource "aws_dynamodb_table"/);
});

test("vLLM on no GPU pool is flagged; scheduling it clears the rule", () => {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_infra", view: "infra", type: "vllm", label: "llama" });
  assert.ok(lint(s).violations.some((v) => v.constraintId === "gpu-needs-pool"));
  s = applyMutation(s, { op: "add_infra", view: "infra", type: "node_pool", label: "gpu-pool", props: { gpu: true } });
  s = applyMutation(s, { op: "connect_infra", view: "infra", from: "gpu-pool", to: "llama", kind: "schedules" });
  assert.equal(lint(s).violations.some((v) => v.constraintId === "gpu-needs-pool"), false);
});
