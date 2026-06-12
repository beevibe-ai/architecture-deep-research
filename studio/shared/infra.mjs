// The Infrastructure layer — the deployment/runtime realization of the logical
// architecture. A k8s-native + cloud-managed component catalog with containment
// (Cluster ▸ Namespace ▸ Workload ▸ Pod, Node pools), infra-specific lint, and a
// compiler that turns the design into real k8s YAML + Terraform.

// Containment levels (a node of level X can contain the levels in `contains`).
export const INFRA_GROUPS = [
  { id: "cluster", label: "Cluster" },
  { id: "workload", label: "Workloads" },
  { id: "network", label: "Networking" },
  { id: "storage", label: "Storage" },
  { id: "scaling", label: "Scaling" },
  { id: "serving", label: "Model Serving" },
  { id: "config", label: "Config" },
  { id: "cloud", label: "Cloud / Managed" },
  { id: "build", label: "Build / Registry" },
];

export const INFRA_EDGE_KINDS = ["exposes", "routes", "mounts", "scales", "backs", "pulls", "schedules"];

// id, group, label, level, contains[], k8sKind|cloud, props(defaults)
const I = (id, group, label, level, extra = {}) => ({
  id,
  group,
  label,
  level,
  contains: extra.contains || [],
  k8sKind: extra.k8sKind || null,
  cloud: extra.cloud || null,
  props: extra.props || {},
});

export const INFRA_CATALOG = [
  // ---- cluster topology ----
  I("cluster", "cluster", "Cluster", "cluster", { contains: ["namespace", "node_pool"], props: { k8s_version: "1.30", provider: "EKS" } }),
  I("namespace", "cluster", "Namespace", "namespace", { contains: ["workload", "network", "storage", "scaling", "serving", "config", "pod"], k8sKind: "Namespace", props: { name: "default" } }),
  I("node_pool", "cluster", "Node Pool", "node_pool", { contains: ["node"], props: { instance_type: "m6i.large", min: 1, max: 5, gpu: false } }),
  I("node", "cluster", "Node", "node", { props: { instance_type: "m6i.large" } }),
  // ---- workloads ----
  I("deployment", "workload", "Deployment", "workload", { contains: ["pod"], k8sKind: "Deployment", props: { image: "app:latest", replicas: 2, cpu: "500m", memory: "512Mi", gpu: 0, port: 8080 } }),
  I("deploy_gap", "workload", "Missing Deploy Config", "leaf", { props: { source: "architecture", reason: "No docker-compose/k8s resource found" } }),
  I("statefulset", "workload", "StatefulSet", "workload", { contains: ["pod"], k8sKind: "StatefulSet", props: { image: "app:latest", replicas: 3, cpu: "1", memory: "2Gi", port: 8080 } }),
  I("daemonset", "workload", "DaemonSet", "workload", { contains: ["pod"], k8sKind: "DaemonSet", props: { image: "agent:latest" } }),
  I("job", "workload", "Job / CronJob", "workload", { k8sKind: "Job", props: { image: "job:latest", schedule: "" } }),
  I("pod", "workload", "Pod", "pod", { props: { image: "app:latest" } }),
  // ---- networking ----
  I("service", "network", "Service", "leaf", { k8sKind: "Service", props: { type: "ClusterIP", port: 80, target_port: 8080 } }),
  I("ingress", "network", "Ingress", "leaf", { k8sKind: "Ingress", props: { host: "app.example.com", tls: true } }),
  I("gateway_api", "network", "Gateway API", "leaf", { k8sKind: "Gateway", props: { listener: "https" } }),
  I("load_balancer", "network", "Load Balancer", "leaf", { cloud: "aws_lb", props: { scheme: "internet-facing" } }),
  // ---- storage ----
  I("pvc", "storage", "PersistentVolumeClaim", "leaf", { k8sKind: "PersistentVolumeClaim", props: { size: "10Gi", storage_class: "gp3", access_mode: "ReadWriteOnce" } }),
  I("storage_class", "storage", "StorageClass", "leaf", { k8sKind: "StorageClass", props: { provisioner: "ebs.csi.aws.com" } }),
  // ---- scaling ----
  I("hpa", "scaling", "HPA", "leaf", { k8sKind: "HorizontalPodAutoscaler", props: { min: 2, max: 10, metric: "cpu", target: 70 } }),
  I("keda_scaledobject", "scaling", "KEDA ScaledObject", "leaf", { k8sKind: "ScaledObject", props: { min: 0, max: 20, trigger: "kafka", lag_threshold: 100 } }),
  I("cluster_autoscaler", "scaling", "Cluster Autoscaler", "leaf", { props: { type: "Karpenter" } }),
  // ---- model serving ----
  I("kserve_inference", "serving", "KServe InferenceService", "workload", { k8sKind: "InferenceService", props: { runtime: "vllm", model: "meta-llama/Llama-3-8B", min_replicas: 0, max_replicas: 4, gpu: 1 } }),
  I("vllm", "serving", "vLLM Server", "workload", { k8sKind: "Deployment", props: { model: "meta-llama/Llama-3-8B", gpu: 1, tensor_parallel: 1, port: 8000 } }),
  I("ray_serve", "serving", "Ray Serve", "workload", { k8sKind: "RayService", props: { replicas: 2 } }),
  // ---- config ----
  I("configmap", "config", "ConfigMap", "leaf", { k8sKind: "ConfigMap", props: {} }),
  I("secret", "config", "Secret", "leaf", { k8sKind: "Secret", props: { source: "vault" } }),
  // ---- cloud / managed (outside the cluster) ----
  I("managed_postgres", "cloud", "Managed Postgres", "leaf", { cloud: "aws_db_instance", props: { engine: "postgres", instance_class: "db.r6g.large", multi_az: true, storage_gb: 100 } }),
  I("dynamodb", "cloud", "DynamoDB", "leaf", { cloud: "aws_dynamodb_table", props: { billing_mode: "PAY_PER_REQUEST", hash_key: "id" } }),
  I("elasticache", "cloud", "ElastiCache (Redis)", "leaf", { cloud: "aws_elasticache_cluster", props: { node_type: "cache.r6g.large" } }),
  I("s3", "cloud", "S3 Bucket", "leaf", { cloud: "aws_s3_bucket", props: { versioning: true } }),
  I("managed_kafka", "cloud", "Managed Kafka (MSK)", "leaf", { cloud: "aws_msk_cluster", props: { brokers: 3 } }),
  // ---- build / registry ----
  I("image", "build", "Container Image", "leaf", { props: { dockerfile: "Dockerfile", tag: "app:latest" } }),
  I("registry", "build", "Registry", "leaf", { props: { url: "ghcr.io/org" } }),
];

const INFRA_BY_ID = new Map(INFRA_CATALOG.map((c) => [c.id, c]));
export const getInfraType = (id) => INFRA_BY_ID.get(id) || null;

export function infraTypesByGroup(catalog = INFRA_CATALOG) {
  const out = {};
  for (const g of INFRA_GROUPS) out[g.id] = [];
  for (const c of catalog) (out[c.group] = out[c.group] || []).push(c);
  return out;
}

export function infraDefaults(typeId) {
  const t = INFRA_BY_ID.get(typeId);
  if (!t) return { type: typeId, group: "workload", level: "leaf", props: {} };
  return { type: t.id, group: t.group, level: t.level, props: { ...t.props } };
}

export function infraVocabulary() {
  return INFRA_GROUPS.map((g) => {
    const types = INFRA_CATALOG.filter((c) => c.group === g.id).map((c) => c.id).join(", ");
    return types ? `${g.label}: ${types}` : null;
  }).filter(Boolean).join("\n");
}

// ---- lint --------------------------------------------------------------------
const isStateful = (n) => n.type === "statefulset" || n.type === "deployment";
const isExposable = (n) => ["deployment", "statefulset", "vllm", "kserve_inference", "ray_serve"].includes(n.type);

export function lintInfra(spec, c, out) {
  const { nodes, edges } = spec.views.infra;
  const has = (from, kind, toType) =>
    edges.some((e) => e.from === from && e.kind === kind && (!toType || (nodes.find((n) => n.id === e.to) || {}).type === toType));
  const incoming = (to, kind) => edges.some((e) => e.to === to && e.kind === kind);
  const flag = (n, msg) => out.push({ constraintId: c.id, view: "infra", nodeId: n.id, message: c.message || msg });

  switch (c.rule) {
    case "stateful_needs_pvc":
      for (const n of nodes)
        if (n.type === "statefulset" && !edges.some((e) => e.from === n.id && e.kind === "mounts"))
          flag(n, `StatefulSet "${n.label}" has no PersistentVolumeClaim.`);
      break;
    case "exposed_needs_service":
      for (const n of nodes)
        if (isExposable(n) && !edges.some((e) => e.to === n.id && e.kind === "exposes"))
          flag(n, `Workload "${n.label}" has no Service in front of it.`);
      break;
    case "gpu_needs_pool": {
      const gpuWorkloads = new Set(["deployment", "statefulset", "vllm", "kserve_inference", "ray_serve"]);
      for (const n of nodes)
        if (gpuWorkloads.has(n.type) && (Number(n.props?.gpu) > 0 || n.type === "vllm" || n.type === "kserve_inference") && !edges.some((e) => e.to === n.id && e.kind === "schedules"))
          flag(n, `GPU workload "${n.label}" isn't scheduled on a GPU node pool.`);
      break;
    }
    case "keda_needs_trigger":
      for (const n of nodes)
        if (n.type === "keda_scaledobject" && !n.props?.trigger)
          flag(n, `KEDA ScaledObject "${n.label}" has no trigger source.`);
      break;
    case "managed_outside_cluster":
      for (const n of nodes)
        if (getInfraType(n.type)?.cloud && hasAncestorOfLevel(nodes, n, "cluster"))
          flag(n, `Managed service "${n.label}" should sit outside the cluster.`);
      break;
    case "pod_needs_image":
      for (const n of nodes)
        if (getInfraType(n.type)?.k8sKind === "Deployment" && !n.props?.image)
          flag(n, `Workload "${n.label}" references no container image.`);
      break;
    default:
      break;
  }
}

function hasAncestorOfLevel(nodes, node, level) {
  let cur = node;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  while (cur && cur.parent) {
    cur = byId.get(cur.parent);
    if (cur && getInfraType(cur.type)?.level === level) return true;
  }
  return false;
}

export function defaultInfraConstraints() {
  return [
    { id: "stateful-needs-pvc", view: "infra", rule: "stateful_needs_pvc" },
    { id: "exposed-needs-service", view: "infra", rule: "exposed_needs_service" },
    { id: "gpu-needs-pool", view: "infra", rule: "gpu_needs_pool" },
    { id: "keda-needs-trigger", view: "infra", rule: "keda_needs_trigger" },
    { id: "managed-outside-cluster", view: "infra", rule: "managed_outside_cluster" },
  ];
}

// ---- manifest compiler -------------------------------------------------------
// Produces real-ish k8s YAML + Terraform. A scaffold the coding agent refines —
// structurally correct, not necessarily cluster-perfect.
export function compileManifests(spec) {
  const { nodes, edges } = spec.views.infra;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ns = nodes.find((n) => n.type === "namespace")?.props?.name || "default";
  const slug = (s) => String(s || "app").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const docs = [];

  const k8s = nodes.filter((n) => getInfraType(n.type)?.k8sKind);
  for (const n of k8s) docs.push(renderK8s(n, { ns, slug, nodes, edges, byId }));

  const cloud = nodes.filter((n) => getInfraType(n.type)?.cloud);
  const tf = cloud.map((n) => renderTerraform(n, slug)).filter(Boolean).join("\n\n");

  const files = [];
  const yaml = docs.filter(Boolean).join("\n---\n");
  if (yaml.trim()) files.push({ path: "deploy/k8s.yaml", content: yaml + "\n" });
  if (tf.trim()) files.push({ path: "deploy/main.tf", content: tf + "\n" });
  return files;
}

function renderK8s(n, ctx) {
  const kind = getInfraType(n.type).k8sKind;
  const { ns, slug, nodes, edges } = ctx;
  const name = slug(n.label);
  const p = n.props || {};
  const meta = `metadata:\n  name: ${name}\n  namespace: ${ns}`;
  switch (kind) {
    case "Namespace":
      return `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${slug(p.name || n.label)}`;
    case "Deployment":
    case "StatefulSet": {
      const gpu = Number(p.gpu) > 0 ? `\n            nvidia.com/gpu: "${p.gpu}"` : "";
      return `apiVersion: apps/v1\nkind: ${kind}\n${meta}\nspec:\n  replicas: ${p.replicas ?? 1}\n  selector:\n    matchLabels: { app: ${name} }\n  template:\n    metadata:\n      labels: { app: ${name} }\n    spec:\n      containers:\n        - name: ${name}\n          image: ${p.image || "app:latest"}\n          ports: [ { containerPort: ${p.port || 8080} } ]\n          resources:\n            requests:\n              cpu: "${p.cpu || "250m"}"\n              memory: "${p.memory || "256Mi"}"\n            limits:${gpu ? gpu : `\n              cpu: "${p.cpu || "500m"}"\n              memory: "${p.memory || "512Mi"}"`}`;
    }
    case "Service": {
      const target = findEdge(edges, n.id, "exposes");
      const sel = target ? slug((ctx.byId.get(target) || {}).label) : name;
      return `apiVersion: v1\nkind: Service\n${meta}\nspec:\n  type: ${p.type || "ClusterIP"}\n  selector: { app: ${sel} }\n  ports: [ { port: ${p.port || 80}, targetPort: ${p.target_port || 8080} } ]`;
    }
    case "Ingress":
      return `apiVersion: networking.k8s.io/v1\nkind: Ingress\n${meta}\nspec:\n  rules:\n    - host: ${p.host || "app.example.com"}\n      http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend: { service: { name: ${name}-svc, port: { number: 80 } } }${p.tls ? `\n  tls: [ { hosts: [ ${p.host || "app.example.com"} ] } ]` : ""}`;
    case "PersistentVolumeClaim":
      return `apiVersion: v1\nkind: PersistentVolumeClaim\n${meta}\nspec:\n  accessModes: [ ${p.access_mode || "ReadWriteOnce"} ]\n  storageClassName: ${p.storage_class || "gp3"}\n  resources: { requests: { storage: ${p.size || "10Gi"} } }`;
    case "HorizontalPodAutoscaler": {
      const target = findEdge(edges, n.id, "scales");
      return `apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\n${meta}\nspec:\n  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: ${target ? slug((ctx.byId.get(target) || {}).label) : "app"} }\n  minReplicas: ${p.min ?? 2}\n  maxReplicas: ${p.max ?? 10}\n  metrics: [ { type: Resource, resource: { name: ${p.metric || "cpu"}, target: { type: Utilization, averageUtilization: ${p.target || 70} } } } ]`;
    }
    case "ScaledObject": {
      const target = findEdge(edges, n.id, "scales");
      return `apiVersion: keda.sh/v1alpha1\nkind: ScaledObject\n${meta}\nspec:\n  scaleTargetRef: { name: ${target ? slug((ctx.byId.get(target) || {}).label) : "app"} }\n  minReplicaCount: ${p.min ?? 0}\n  maxReplicaCount: ${p.max ?? 20}\n  triggers: [ { type: ${p.trigger || "kafka"}, metadata: { lagThreshold: "${p.lag_threshold || 100}" } } ]`;
    }
    case "InferenceService":
      return `apiVersion: serving.kserve.io/v1beta1\nkind: InferenceService\n${meta}\nspec:\n  predictor:\n    minReplicas: ${p.min_replicas ?? 0}\n    maxReplicas: ${p.max_replicas ?? 3}\n    model:\n      modelFormat: { name: ${p.runtime || "vllm"} }\n      storageUri: hf://${p.model || "meta-llama/Llama-3-8B"}\n      resources: { limits: { nvidia.com/gpu: "${p.gpu || 1}" } }`;
    case "ConfigMap":
      return `apiVersion: v1\nkind: ConfigMap\n${meta}\ndata: {}`;
    case "Secret":
      return `apiVersion: v1\nkind: Secret\n${meta}\ntype: Opaque\n# source: ${p.source || "vault"} — do not commit real values`;
    default:
      return `# ${kind} ${name} (no template)`;
  }
}

function renderTerraform(n, slug) {
  const t = getInfraType(n.type);
  const name = slug(n.label).replace(/-/g, "_");
  const p = n.props || {};
  switch (t.cloud) {
    case "aws_db_instance":
      return `resource "aws_db_instance" "${name}" {\n  engine         = "${p.engine || "postgres"}"\n  instance_class = "${p.instance_class || "db.r6g.large"}"\n  allocated_storage = ${p.storage_gb || 100}\n  multi_az       = ${!!p.multi_az}\n}`;
    case "aws_dynamodb_table":
      return `resource "aws_dynamodb_table" "${name}" {\n  name         = "${slug(n.label)}"\n  billing_mode = "${p.billing_mode || "PAY_PER_REQUEST"}"\n  hash_key     = "${p.hash_key || "id"}"\n  attribute { name = "${p.hash_key || "id"}"  type = "S" }\n}`;
    case "aws_elasticache_cluster":
      return `resource "aws_elasticache_cluster" "${name}" {\n  engine    = "redis"\n  node_type = "${p.node_type || "cache.r6g.large"}"\n  num_cache_nodes = 1\n}`;
    case "aws_s3_bucket":
      return `resource "aws_s3_bucket" "${name}" {\n  bucket = "${slug(n.label)}"\n}`;
    case "aws_msk_cluster":
      return `resource "aws_msk_cluster" "${name}" {\n  cluster_name = "${slug(n.label)}"\n  number_of_broker_nodes = ${p.brokers || 3}\n}`;
    case "aws_lb":
      return `resource "aws_lb" "${name}" {\n  load_balancer_type = "application"\n  internal = ${p.scheme === "internal"}\n}`;
    default:
      return `# ${t.cloud} ${name}`;
  }
}

const findEdge = (edges, from, kind) => (edges.find((e) => e.from === from && e.kind === kind) || {}).to || null;
