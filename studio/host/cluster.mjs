import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileManifests } from "../shared/infra.mjs";

const execFileP = promisify(execFile);
const KUBE_RESOURCES = [
  "deployments.apps",
  "statefulsets.apps",
  "daemonsets.apps",
  "services",
  "ingresses.networking.k8s.io",
  "persistentvolumeclaims",
  "pods",
  "jobs.batch",
  "horizontalpodautoscalers.autoscaling",
];

export function writeGeneratedManifests(spec, baseDir) {
  const files = compileManifests(spec);
  const written = [];
  for (const f of files) {
    const p = path.join(baseDir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    written.push({ ...f, absPath: p });
  }
  return {
    files: written,
    deployDir: path.join(baseDir, "deploy"),
    k8sPath: written.find((f) => f.path.endsWith("k8s.yaml"))?.absPath || null,
    namespace: namespaceForSpec(spec),
  };
}

export function namespaceForSpec(spec) {
  const ns = spec.views?.infra?.nodes?.find((n) => n.type === "namespace");
  return safeName(ns?.props?.name || ns?.label || "default");
}

export async function validateManifests(spec, opts = {}) {
  const target = writeGeneratedManifests(spec, opts.baseDir);
  ensureK8s(target);
  const runner = opts.runner || run;
  const res = await runner("kubectl", ["apply", "--dry-run=client", "--validate=false", "-f", target.k8sPath], { cwd: opts.cwd });
  return { ...target, stdout: res.stdout, stderr: res.stderr, message: "Kubernetes YAML parsed locally with kubectl client dry-run." };
}

export async function deployToMinikube(spec, opts = {}) {
  const target = writeGeneratedManifests(spec, opts.baseDir);
  ensureK8s(target);
  const runner = opts.runner || run;
  const profile = opts.profile || "minikube";
  const context = opts.context || profile;
  await runner("minikube", ["-p", profile, "status"], { cwd: opts.cwd, timeout: 15000 });
  await runner("kubectl", ["--context", context, "apply", "-f", target.k8sPath], { cwd: opts.cwd });
  await rolloutStatus(spec, runner, { cwd: opts.cwd, context, namespace: target.namespace });
  return { ...target, profile, context, message: `Applied manifests to minikube profile "${profile}".` };
}

export async function teardownMinikube(spec, opts = {}) {
  const target = writeGeneratedManifests(spec, opts.baseDir);
  ensureK8s(target);
  const runner = opts.runner || run;
  const profile = opts.profile || "minikube";
  const context = opts.context || profile;
  await runner("kubectl", ["--context", context, "delete", "-f", target.k8sPath, "--ignore-not-found"], { cwd: opts.cwd });
  return { ...target, profile, context, statusById: {}, summary: { running: 0, pending: 0, error: 0, unknown: 0 }, message: `Deleted generated manifests from minikube profile "${profile}".` };
}

export async function refreshClusterStatus(spec, opts = {}) {
  const runner = opts.runner || run;
  const profile = opts.profile || "minikube";
  const context = opts.context || profile;
  const namespace = opts.namespace || namespaceForSpec(spec);
  const res = await runner("kubectl", [
    "--context",
    context,
    "get",
    KUBE_RESOURCES.join(","),
    "-n",
    namespace,
    "-o",
    "json",
    "--ignore-not-found",
  ], { cwd: opts.cwd });
  const parsed = res.stdout?.trim() ? JSON.parse(res.stdout) : { items: [] };
  return { profile, context, namespace, ...statusFromKubectlJson(spec, parsed) };
}

export function statusFromKubectlJson(spec, json) {
  const known = new Set((spec.views?.infra?.nodes || []).map((n) => n.id));
  const statusById = {};
  for (const item of json.items || []) {
    const labels = item.metadata?.labels || {};
    const id = labels["adr.studio/node-id"];
    if (!id || !known.has(id)) continue;
    const status = statusForItem(item);
    statusById[id] = mergeStatus(statusById[id], status);
  }
  for (const node of spec.views?.infra?.nodes || []) {
    if (!statusById[node.id]) statusById[node.id] = { state: "unknown", detail: "Not seen in cluster", resources: [] };
  }
  const summary = { running: 0, pending: 0, error: 0, unknown: 0 };
  for (const s of Object.values(statusById)) summary[s.state] = (summary[s.state] || 0) + 1;
  return { statusById, summary };
}

async function rolloutStatus(spec, runner, { cwd, context, namespace }) {
  const types = new Set((spec.views?.infra?.nodes || []).map((n) => n.type));
  const checks = [
    ["deployment", "deployment"],
    ["statefulset", "statefulset"],
    ["daemonset", "daemonset"],
  ];
  for (const [type, resource] of checks) {
    if (!types.has(type)) continue;
    await runner("kubectl", ["--context", context, "rollout", "status", resource, "--all", "-n", namespace, "--timeout=60s"], { cwd, timeout: 70000 });
  }
}

function ensureK8s(target) {
  if (!target.k8sPath) throw new Error("No Kubernetes manifests were generated from this infra view.");
}

async function run(cmd, args, opts = {}) {
  try {
    return await execFileP(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeout || 30000,
      maxBuffer: 1024 * 1024 * 4,
      env: process.env,
    });
  } catch (err) {
    const stderr = String(err.stderr || "").trim();
    const stdout = String(err.stdout || "").trim();
    const detail = stderr || stdout || err.message;
    throw new Error(`${cmd} ${args.join(" ")} failed: ${detail}`);
  }
}

function statusForItem(item) {
  const kind = item.kind || "";
  const name = item.metadata?.name || kind;
  if (kind === "Deployment" || kind === "StatefulSet") {
    const desired = Number(item.spec?.replicas ?? 1);
    const ready = Number(item.status?.readyReplicas || 0);
    const unavailable = Number(item.status?.unavailableReplicas || 0);
    if (ready >= desired && unavailable === 0) return res("running", `${kind} ${name}: ${ready}/${desired} ready`, item);
    if (unavailable > 0) return res("error", `${kind} ${name}: ${ready}/${desired} ready, ${unavailable} unavailable`, item);
    return res("pending", `${kind} ${name}: ${ready}/${desired} ready`, item);
  }
  if (kind === "DaemonSet") {
    const desired = Number(item.status?.desiredNumberScheduled || 0);
    const ready = Number(item.status?.numberReady || 0);
    return res(ready >= desired ? "running" : "pending", `${kind} ${name}: ${ready}/${desired} ready`, item);
  }
  if (kind === "Pod") {
    const waiting = (item.status?.containerStatuses || []).find((c) => c.state?.waiting)?.state?.waiting?.reason;
    if (waiting && /crash|error|imagepull|backoff/i.test(waiting)) return res("error", `Pod ${name}: ${waiting}`, item);
    if (item.status?.phase === "Running") return res("running", `Pod ${name}: Running`, item);
    if (item.status?.phase === "Failed") return res("error", `Pod ${name}: Failed`, item);
    return res("pending", `Pod ${name}: ${item.status?.phase || "Pending"}`, item);
  }
  if (kind === "PersistentVolumeClaim") {
    const phase = item.status?.phase || "Pending";
    return res(phase === "Bound" ? "running" : "pending", `PVC ${name}: ${phase}`, item);
  }
  if (kind === "HorizontalPodAutoscaler") {
    const current = item.status?.currentReplicas ?? "?";
    const desired = item.status?.desiredReplicas ?? "?";
    return res("running", `HPA ${name}: ${current}/${desired} replicas`, item);
  }
  return res("running", `${kind} ${name}: present`, item);
}

function res(state, detail, item) {
  return { state, detail, resources: [`${item.kind}/${item.metadata?.name || ""}`] };
}

function mergeStatus(a, b) {
  if (!a) return b;
  const rank = { error: 3, pending: 2, unknown: 1, running: 0 };
  const state = rank[b.state] > rank[a.state] ? b.state : a.state;
  return {
    state,
    detail: [...new Set([a.detail, b.detail].filter(Boolean))].join("; "),
    resources: [...new Set([...(a.resources || []), ...(b.resources || [])])],
  };
}

function safeName(s) {
  const out = String(s || "default").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return out || "default";
}
