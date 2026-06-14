// The Component Catalog — the vocabulary that lets the canvas speak agent-native
// and distributed-systems language. A data-driven registry of component types
// grouped by category, each with its plane, a tech picklist (with pick-when
// guidance), and a coarse `kind` so the legacy architecture lint still applies.
//
// Teams extend it with a project .adr/catalog.json (merged by mergeCatalog).

export const PLANES = [
  { id: "control", label: "Control plane", color: "#c8a7ff" },
  { id: "execution", label: "Execution plane", color: "#b9c5ff" },
  { id: "data", label: "Data plane", color: "#9ee3c6" },
];

export const CATEGORIES = [
  { id: "agent_harness", label: "Agent harness", color: "#b9c5ff" },
  { id: "memory", label: "Memory", color: "#c8a7ff" },
  { id: "data", label: "Data stores", color: "#9ee3c6" },
  { id: "messaging", label: "Messaging", color: "#ffd7a3" },
  { id: "compute", label: "Compute", color: "#7fd7ff" },
  { id: "governance", label: "Governance", color: "#ffb9d5" },
  { id: "observability", label: "Observability", color: "#a3ffe0" },
  { id: "edge", label: "Edge / External", color: "#ffb9d5" },
];

// Edge semantics — distributed-systems + governance + observability properties.
export const DELIVERY = ["best-effort", "at-least-once", "exactly-once", "ordered"];
export const CONSISTENCY = ["none", "eventual", "linearizable", "vector_clock", "lamport"];

// id, category, label, plane, coarseKind (maps to a legacy NODE_KIND), tech[],
// pick_when{}, needs_upstream[] (catalog ids that should feed it).
const C = (id, category, label, plane, kind, extra = {}) => ({
  id,
  category,
  label,
  plane,
  kind,
  tech: extra.tech || [],
  pick_when: extra.pick_when || {},
  needs_upstream: extra.needs_upstream || [],
  container: extra.container || false, // can nest child components (e.g. agent_runtime)
  contains: extra.contains || [], // allowed child type ids ([] = any)
});

export const CATALOG = [
  // ---- agent harness (your harness diagram) ----
  C("orchestrator", "agent_harness", "Orchestrator", "control", "service"),
  C("query_engine", "agent_harness", "Query Engine", "control", "service"),
  C("agent_loop", "agent_harness", "Agent Loop", "execution", "service"),
  C("context_layer", "agent_harness", "Context Layer", "control", "service"),
  C("tool_system", "agent_harness", "Tool System", "execution", "service"),
  C("permission_layer", "agent_harness", "Permission Layer", "control", "gateway"),
  C("semantic_gateway", "agent_harness", "Semantic Gateway", "control", "gateway"),
  C("model_router", "agent_harness", "Model Router", "control", "gateway", { tech: ["LiteLLM", "OpenRouter", "Bedrock", "Vertex"] }),
  C("guardrail", "agent_harness", "Guardrail", "control", "gateway", { tech: ["Llama Guard", "NeMo Guardrails", "Rebuff", "custom"] }),
  C("subagent", "agent_harness", "Subagent", "execution", "service"),
  C("mcp_server", "agent_harness", "MCP Server", "execution", "service"),
  C("skill", "agent_harness", "Skill", "execution", "service", { tech: ["prompt", "SOP", "workflow"] }),
  // Agent Runtime — a composite that nests its internals (State Manager, Task
  // Queue, Scheduler, Logger, Monitor). The "负责稳定运行" execution core.
  C("agent_runtime", "agent_harness", "Agent Runtime", "execution", "service", {
    container: true,
    contains: ["state_manager", "task_queue", "scheduler", "logger", "monitor"],
  }),
  C("state_manager", "agent_harness", "State Manager", "control", "service"),
  C("task_queue", "agent_harness", "Task Queue", "execution", "queue"),
  C("scheduler", "agent_harness", "Scheduler", "control", "service"),
  C("logger", "agent_harness", "Logger", "data", "service"),
  C("monitor", "agent_harness", "Monitor", "data", "service"),
  // ---- memory (your L1–L4 stack) ----
  C("working_memory", "memory", "Working Memory", "data", "datastore", { tech: ["in-context", "JSONL transcript"] }),
  C("long_term_memory", "memory", "Long-term Memory", "data", "datastore", { tech: ["MEMORY.md", "state.db", "SQLite"] }),
  C("episodic_store", "memory", "Episodic Store", "data", "datastore", { tech: ["state.db", "FTS5", "JSONL transcript"] }),
  C("memory_provider", "memory", "Memory Provider", "data", "external", { tech: ["mem0", "Zep", "Letta", "custom"] }),
  C("memory_manager", "memory", "Memory Manager", "control", "service"),
  // ---- data stores ----
  C("relational_db", "data", "Relational DB", "data", "datastore", { tech: ["Postgres", "MySQL", "SQLite"], pick_when: { Postgres: "default OLTP", SQLite: "embedded / local agent state" } }),
  C("vector_db", "data", "Vector DB", "data", "datastore", { tech: ["pgvector", "Qdrant", "Weaviate", "Milvus", "Pinecone", "LanceDB", "Chroma"], pick_when: { pgvector: "already on Postgres", Qdrant: "standalone high-recall ANN", LanceDB: "embedded / on-disk" }, needs_upstream: ["agent_loop", "tool_system", "service"] }),
  C("search_index", "data", "Search Index", "data", "datastore", { tech: ["SQLite FTS5", "Postgres tsvector", "Elasticsearch", "Meilisearch", "Typesense"], pick_when: { "SQLite FTS5": "embedded full-text, zero infra", Meilisearch: "fast typo-tolerant", Elasticsearch: "scale + aggregations" } }),
  C("kv_store", "data", "KV Store", "data", "datastore", { tech: ["Redis", "etcd", "DynamoDB"] }),
  C("cache", "data", "Cache", "data", "datastore", { tech: ["Redis", "Memcached", "in-memory"] }),
  C("ledger", "data", "Ledger / Event Store", "data", "datastore", { tech: ["EventStoreDB", "Kafka log", "append-only table"] }),
  // ---- messaging ----
  C("event_queue", "messaging", "Event Queue", "data", "queue", { tech: ["Kafka", "NATS", "RabbitMQ", "SQS", "Redpanda"], pick_when: { Kafka: "high-throughput ordered log", NATS: "lightweight pub/sub", SQS: "managed simple queue" } }),
  C("stream", "messaging", "Stream", "data", "queue", { tech: ["Kafka", "Kinesis", "Redpanda", "Flink"] }),
  C("pubsub_broker", "messaging", "Pub/Sub Broker", "data", "queue", { tech: ["NATS", "Google Pub/Sub", "MQTT"] }),
  C("task_queue", "messaging", "Task Queue", "execution", "queue", { tech: ["Celery", "Temporal", "BullMQ", "Sidekiq"], pick_when: { Temporal: "durable workflows / retries" } }),
  // ---- compute ----
  C("service", "compute", "Service", "execution", "service"),
  C("function", "compute", "Function", "execution", "service", { tech: ["Lambda", "Cloud Run", "Vercel"] }),
  C("worker", "compute", "Worker", "execution", "worker"),
  C("gateway", "compute", "API Gateway", "control", "gateway", { tech: ["Kong", "Envoy", "NGINX", "APISIX"] }),
  C("load_balancer", "compute", "Load Balancer", "control", "gateway", { tech: ["Envoy", "HAProxy", "ALB"] }),
  // ---- governance ----
  C("rbac_policy", "governance", "RBAC Policy", "control", "gateway", { tech: ["OPA", "Casbin", "Cedar", "custom"] }),
  C("secrets_manager", "governance", "Secrets Manager", "control", "external", { tech: ["Vault", "AWS Secrets Manager", "Doppler"] }),
  C("audit_log", "governance", "Audit Log", "data", "datastore", { tech: ["append-only table", "Loki", "S3"] }),
  C("rate_limiter", "governance", "Rate Limiter", "control", "gateway", { tech: ["Redis token bucket", "Envoy", "custom"] }),
  // ---- observability ----
  C("otel_collector", "observability", "OTel Collector", "control", "external", { tech: ["OpenTelemetry Collector"] }),
  C("tracer", "observability", "Tracer", "control", "external", { tech: ["Jaeger", "Tempo", "Honeycomb", "Langfuse"], pick_when: { Langfuse: "LLM/agent traces", Tempo: "Grafana stack" } }),
  C("metrics", "observability", "Metrics", "data", "datastore", { tech: ["Prometheus", "VictoriaMetrics"] }),
  C("log_sink", "observability", "Log Sink", "data", "datastore", { tech: ["Loki", "Elasticsearch", "CloudWatch"] }),
  C("evaluator", "observability", "Evaluator / Evals", "execution", "service", { tech: ["Langfuse", "Braintrust", "Ragas", "custom"] }),
  // ---- edge / external ----
  C("client", "edge", "Client", "execution", "client"),
  C("llm_provider", "edge", "LLM Provider", "data", "external", { tech: ["Anthropic", "OpenAI", "Bedrock", "Vertex", "local"] }),
  C("external_api", "edge", "External API", "data", "external"),
  C("webhook", "edge", "Webhook", "data", "external"),
];

const BY_ID = new Map(CATALOG.map((c) => [c.id, c]));

export function getType(id) {
  return BY_ID.get(id) || null;
}

// Named layers for the "big picture" layered layout (generalizes the 3 planes).
// Ordered top → bottom.
export const LAYERS = [
  { id: "clients", label: "Clients / Access" },
  { id: "orchestration", label: "Orchestration" },
  { id: "capabilities", label: "Capabilities" },
  { id: "memory", label: "Memory" },
  { id: "knowledge", label: "Knowledge" },
  { id: "model", label: "Model" },
  { id: "tools", label: "Tools" },
  { id: "external", label: "External Services" },
  { id: "infrastructure", label: "Infrastructure" },
];
const LAYER_BY_ID = new Map(LAYERS.map((l) => [l.id, l]));
export const layerLabel = (id) => (LAYER_BY_ID.get(id) || {}).label || id;

// Type-level overrides where category alone is too coarse.
const TYPE_LAYER = {
  orchestrator: "orchestration", query_engine: "orchestration", agent_runtime: "orchestration",
  scheduler: "orchestration", state_manager: "orchestration", context_layer: "orchestration",
  agent_loop: "capabilities", tool_system: "capabilities", subagent: "capabilities", skill: "capabilities",
  task_queue: "capabilities", semantic_gateway: "capabilities", guardrail: "capabilities", permission_layer: "infrastructure",
  gateway: "orchestration", load_balancer: "orchestration",
  mcp_server: "tools",
  model_router: "model", llm_provider: "model",
  external_api: "external", webhook: "external",
  vector_db: "knowledge", search_index: "knowledge",
  logger: "infrastructure", monitor: "infrastructure",
};
const CATEGORY_LAYER = {
  edge: "clients",
  agent_harness: "orchestration",
  memory: "memory",
  data: "knowledge",
  messaging: "infrastructure",
  compute: "capabilities",
  governance: "infrastructure",
  observability: "infrastructure",
};

// Which layer band a component belongs to: explicit node.layer wins, then a
// type override, then its category, then a sensible default.
export function layerForNode(node) {
  return node.layer || TYPE_LAYER[node.type] || CATEGORY_LAYER[node.category] || "capabilities";
}

export function typesByCategory(catalog = CATALOG) {
  const out = {};
  for (const cat of CATEGORIES) out[cat.id] = [];
  for (const c of catalog) (out[c.category] = out[c.category] || []).push(c);
  return out;
}

// Resolve creation defaults for a node of catalog `type` (falls back gracefully).
export function nodeDefaults(typeId, catalog = CATALOG) {
  const t = catalog.find((c) => c.id === typeId) || BY_ID.get(typeId);
  if (!t) return { type: typeId, category: "compute", plane: "execution", kind: "service", tech: "" };
  return { type: t.id, category: t.category, plane: t.plane, kind: t.kind, tech: t.tech[0] || "" };
}

// Merge a project override catalog (array of partial/whole entries) onto the
// built-in. Entries with an existing id are shallow-merged; new ids are appended.
export function mergeCatalog(overrides) {
  if (!Array.isArray(overrides) || !overrides.length) return CATALOG.slice();
  const merged = CATALOG.map((c) => ({ ...c }));
  const idx = new Map(merged.map((c, i) => [c.id, i]));
  for (const o of overrides) {
    if (!o || !o.id) continue;
    if (idx.has(o.id)) merged[idx.get(o.id)] = { ...merged[idx.get(o.id)], ...o };
    else merged.push({ tech: [], pick_when: {}, needs_upstream: [], plane: "execution", kind: "service", category: "compute", ...o });
  }
  return merged;
}

// Compact catalog description for the assistant's system prompt.
export function catalogVocabulary(catalog = CATALOG) {
  const byCat = typesByCategory(catalog);
  return CATEGORIES.map((cat) => {
    const types = (byCat[cat.id] || []).map((t) => t.id).join(", ");
    return types ? `${cat.label}: ${types}` : null;
  })
    .filter(Boolean)
    .join("\n");
}
