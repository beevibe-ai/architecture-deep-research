import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptySpec, applyMutation, resolve, __resetIds } from "../shared/ir.mjs";
import { statusFromKubectlJson, namespaceForSpec, validateManifests } from "./cluster.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

beforeEach(() => __resetIds(0));

function specWithInfra() {
  let s = emptySpec();
  s = applyMutation(s, { op: "add_infra", view: "infra", type: "namespace", label: "app-ns", props: { name: "app" } });
  s = applyMutation(s, { op: "add_infra", view: "infra", type: "deployment", label: "API", props: { image: "api:latest", replicas: 2 } });
  s = applyMutation(s, { op: "add_infra", view: "infra", type: "pvc", label: "pg-data" });
  return s;
}

test("statusFromKubectlJson maps kubectl resources back to infra node ids", () => {
  const spec = specWithInfra();
  const api = resolve(spec, "infra", "API");
  const pvc = resolve(spec, "infra", "pg-data");
  const status = statusFromKubectlJson(spec, {
    items: [
      {
        kind: "Deployment",
        metadata: { name: "api", labels: { "adr.studio/node-id": api.id } },
        spec: { replicas: 2 },
        status: { readyReplicas: 2 },
      },
      {
        kind: "PersistentVolumeClaim",
        metadata: { name: "pg-data", labels: { "adr.studio/node-id": pvc.id } },
        status: { phase: "Pending" },
      },
    ],
  });

  assert.equal(status.statusById[api.id].state, "running");
  assert.equal(status.statusById[pvc.id].state, "pending");
  assert.equal(status.summary.running, 1);
  assert.equal(status.summary.pending, 1);
  assert.ok(status.summary.unknown >= 1);
});

test("validateManifests writes YAML and calls kubectl client dry-run", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adr-cluster-"));
  const calls = [];
  const spec = specWithInfra();
  const res = await validateManifests(spec, {
    baseDir: tmp,
    runner: async (cmd, args) => {
      calls.push([cmd, args]);
      return { stdout: "ok", stderr: "" };
    },
  });

  assert.equal(namespaceForSpec(spec), "app");
  assert.equal(fs.existsSync(path.join(tmp, "deploy", "k8s.yaml")), true);
  assert.equal(calls[0][0], "kubectl");
  assert.deepEqual(calls[0][1].slice(0, 4), ["apply", "--dry-run=client", "--validate=false", "-f"]);
  assert.equal(res.message, "Kubernetes YAML parsed locally with kubectl client dry-run.");
});
