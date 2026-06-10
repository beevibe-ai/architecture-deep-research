// Skills — architect-grade design recipes. Instead of the agent free-handing 20
// low-level add_node/connect calls (random, error-prone), it picks a skill and
// the harness expands it deterministically into a coherent, correctly-planed,
// lint-clean subgraph (then auto-lays-it-out). The model chooses patterns and
// parameters, like a real architect; it does not place every pixel.
//
// A skill's build(params) returns an array of plain mutation objects (the same
// ops applyMutation already understands), so skills compose with everything.

const N = (type, label, extra = {}) => ({ op: "add_node", view: "architecture", type, label, ...extra });
const E = (from, to, extra = {}) => ({ op: "connect", view: "architecture", from, to, ...extra });
const SEM = (from, to, props) => ({ op: "set_edge_semantics", view: "architecture", from, to, ...props });

export const SKILLS = [
  {
    id: "agent_runtime",
    label: "Agent Runtime",
    view: "architecture",
    description: "An agent runtime container with its internals (state manager, task queue, scheduler, logger, monitor).",
    params: [{ name: "name", default: "Agent Runtime" }],
    build: (p) => [{ op: "scaffold_runtime", label: p.name || "Agent Runtime" }],
  },
  {
    id: "agentic_rag",
    label: "Agentic RAG",
    view: "architecture",
    description: "Retrieval-augmented generation: gateway → orchestrator → retriever/embedder → vector store (+ optional keyword index) + LLM. Hybrid optional.",
    params: [
      { name: "vector", default: "pgvector", options: ["pgvector", "Qdrant", "Weaviate", "LanceDB"] },
      { name: "hybrid", default: false },
    ],
    build: (p) => {
      const muts = [
        N("semantic_gateway", "Semantic Gateway"),
        N("orchestrator", "Orchestrator"),
        N("service", "Retriever", { tech: "embedder" }),
        N("vector_db", "Vector Store", { tech: p.vector || "pgvector" }),
        N("llm_provider", "LLM"),
        E("Semantic Gateway", "Orchestrator", { protocol: "http" }),
        E("Orchestrator", "Retriever", { protocol: "grpc" }),
        E("Retriever", "Vector Store", { protocol: "sql", kind: "calls" }),
        E("Orchestrator", "LLM", { protocol: "http" }),
        E("Retriever", "LLM", { protocol: "http" }),
      ];
      if (p.hybrid) {
        muts.push(N("search_index", "Keyword Index", { tech: "SQLite FTS5" }));
        muts.push(E("Retriever", "Keyword Index", { protocol: "sql" }));
      }
      return muts;
    },
  },
  {
    id: "memory_subsystem",
    label: "Memory Subsystem",
    view: "architecture",
    description: "Working / long-term / episodic memory + a semantic (vector) memory behind an embedder, coordinated by a memory manager.",
    params: [{ name: "vector", default: "pgvector", options: ["pgvector", "Qdrant", "LanceDB"] }],
    build: (p) => [
      N("memory_manager", "Memory Manager"),
      N("working_memory", "Working Memory"),
      N("long_term_memory", "Long-term Memory"),
      N("episodic_store", "Episodic Store"),
      N("service", "Embedder"),
      N("vector_db", "Semantic Memory", { tech: p.vector || "pgvector" }),
      E("Memory Manager", "Working Memory", { protocol: "internal" }),
      E("Memory Manager", "Long-term Memory", { protocol: "sql" }),
      E("Memory Manager", "Episodic Store", { protocol: "sql" }),
      E("Memory Manager", "Embedder", { protocol: "grpc" }),
      E("Embedder", "Semantic Memory", { protocol: "sql" }),
    ],
  },
  {
    id: "three_tier_web",
    label: "Three-tier Web",
    view: "architecture",
    description: "Client → API gateway → service → relational database. The classic web tier, gateway-fronted.",
    params: [{ name: "db", default: "Postgres", options: ["Postgres", "MySQL"] }],
    build: (p) => [
      N("client", "Web Client"),
      N("gateway", "API Gateway"),
      N("service", "App Service"),
      N("relational_db", "Database", { tech: p.db || "Postgres" }),
      E("Web Client", "API Gateway", { protocol: "http" }),
      E("API Gateway", "App Service", { protocol: "http" }),
      E("App Service", "Database", { protocol: "sql" }),
    ],
  },
  {
    id: "event_driven",
    label: "Event-driven",
    view: "architecture",
    description: "Producer service → event queue → consumer worker, with ordered at-least-once delivery.",
    params: [{ name: "broker", default: "Kafka", options: ["Kafka", "NATS", "SQS"] }],
    build: (p) => [
      N("service", "Producer"),
      N("event_queue", "Event Bus", { tech: p.broker || "Kafka" }),
      N("worker", "Consumer"),
      E("Producer", "Event Bus", { kind: "publishes", protocol: "event" }),
      E("Event Bus", "Consumer", { kind: "subscribes", protocol: "event" }),
      SEM("Producer", "Event Bus", { delivery: "at-least-once", consistency: "ordered" }),
    ],
  },
  {
    id: "observability_stack",
    label: "Observability Stack",
    view: "architecture",
    description: "OTel collector fanning out to a tracer, metrics, and a log sink.",
    params: [{ name: "tracer", default: "Langfuse", options: ["Langfuse", "Jaeger", "Tempo"] }],
    build: (p) => [
      N("otel_collector", "OTel Collector"),
      N("tracer", "Tracer", { tech: p.tracer || "Langfuse" }),
      N("metrics", "Metrics"),
      N("log_sink", "Logs"),
      E("OTel Collector", "Tracer", { protocol: "grpc" }),
      E("OTel Collector", "Metrics", { protocol: "grpc" }),
      E("OTel Collector", "Logs", { protocol: "grpc" }),
    ],
  },
  {
    id: "model_serving",
    label: "Model Serving (k8s)",
    view: "infra",
    description: "Infrastructure: a cluster + namespace with a KServe/vLLM inference service on a GPU node pool, fronted by a Service and KEDA-autoscaled.",
    params: [{ name: "model", default: "meta-llama/Llama-3-8B" }],
    build: (p) => [
      { op: "add_infra", view: "infra", type: "cluster", label: "prod" },
      { op: "add_infra", view: "infra", type: "namespace", label: "serving", parent: "prod", props: { name: "serving" } },
      { op: "add_infra", view: "infra", type: "node_pool", label: "gpu-pool", parent: "prod", props: { gpu: true, instance_type: "g5.xlarge" } },
      { op: "add_infra", view: "infra", type: "kserve_inference", label: "LLM Serve", parent: "serving", props: { model: p.model || "meta-llama/Llama-3-8B", gpu: 1 } },
      { op: "add_infra", view: "infra", type: "service", label: "serve-svc", parent: "serving" },
      { op: "add_infra", view: "infra", type: "keda_scaledobject", label: "autoscale", parent: "serving", props: { trigger: "http", min: 0, max: 4 } },
      { op: "connect_infra", view: "infra", from: "gpu-pool", to: "LLM Serve", kind: "schedules" },
      { op: "connect_infra", view: "infra", from: "serve-svc", to: "LLM Serve", kind: "exposes" },
      { op: "connect_infra", view: "infra", from: "autoscale", to: "LLM Serve", kind: "scales" },
    ],
  },
  {
    id: "crud_starter",
    label: "CRUD starter",
    view: "data_model",
    description: "A starter data model: User, Order, Product entities with keys and relations.",
    params: [],
    build: () => [
      { op: "add_entity", view: "data_model", name: "User", fields: [{ name: "id", type: "uuid", pk: true, nullable: false }, { name: "email", type: "text" }] },
      { op: "add_entity", view: "data_model", name: "Order", fields: [{ name: "id", type: "uuid", pk: true, nullable: false }, { name: "total", type: "float" }] },
      { op: "add_entity", view: "data_model", name: "Product", fields: [{ name: "id", type: "uuid", pk: true, nullable: false }, { name: "name", type: "text" }] },
      { op: "add_relation", view: "data_model", from: "User", to: "Order", cardinality: "1:N", label: "places" },
      { op: "add_relation", view: "data_model", from: "Order", to: "Product", cardinality: "N:M", label: "contains" },
    ],
  },
  {
    id: "request_flow",
    label: "Request flow",
    view: "flows",
    description: "A starter flowchart: receive → validate → decision → handle/reject → respond.",
    params: [],
    build: () => [
      { op: "add_flow", view: "flows", name: "Request" },
      { op: "add_step", view: "flows", flow: "Request", type: "start", label: "Receive" },
      { op: "add_step", view: "flows", flow: "Request", type: "process", label: "Validate" },
      { op: "add_step", view: "flows", flow: "Request", type: "decision", label: "Valid?" },
      { op: "add_step", view: "flows", flow: "Request", type: "process", label: "Handle" },
      { op: "add_step", view: "flows", flow: "Request", type: "process", label: "Reject" },
      { op: "add_step", view: "flows", flow: "Request", type: "end", label: "Respond" },
      { op: "add_transition", view: "flows", flow: "Request", from: "Receive", to: "Validate" },
      { op: "add_transition", view: "flows", flow: "Request", from: "Validate", to: "Valid?" },
      { op: "add_transition", view: "flows", flow: "Request", from: "Valid?", to: "Handle", label: "yes" },
      { op: "add_transition", view: "flows", flow: "Request", from: "Valid?", to: "Reject", label: "no" },
      { op: "add_transition", view: "flows", flow: "Request", from: "Handle", to: "Respond" },
      { op: "add_transition", view: "flows", flow: "Request", from: "Reject", to: "Respond" },
    ],
  },
  {
    id: "agent_hierarchy",
    label: "Agent class hierarchy",
    view: "classes",
    description: "An abstract AgentBase with ReactAgent / PlanExecuteAgent / CodeActAgent / MCPAgent subclasses.",
    params: [],
    build: () => [
      { op: "add_class", view: "classes", name: "AgentBase", stereotype: "abstract", members: [
        { kind: "attribute", name: "model", type: "BaseChatModel" },
        { kind: "attribute", name: "tools", type: "List[BaseTool]" },
        { kind: "method", name: "ainvoke(messages)", type: "AIMessage" },
        { kind: "method", name: "astream(messages)", type: "AsyncGenerator" },
      ] },
      { op: "add_class", view: "classes", name: "ReactAgent", members: [{ kind: "attribute", name: "graph", type: "StateGraph" }] },
      { op: "add_class", view: "classes", name: "PlanExecuteAgent", members: [{ kind: "attribute", name: "mcp_manager", type: "MCPManager" }] },
      { op: "add_class", view: "classes", name: "CodeActAgent", members: [{ kind: "attribute", name: "sandbox", type: "PyodideSandbox" }] },
      { op: "add_class", view: "classes", name: "MCPAgent", members: [{ kind: "attribute", name: "mcp_config", type: "MCPConfig" }] },
      { op: "connect_class", view: "classes", from: "ReactAgent", to: "AgentBase", kind: "inherits" },
      { op: "connect_class", view: "classes", from: "PlanExecuteAgent", to: "AgentBase", kind: "inherits" },
      { op: "connect_class", view: "classes", from: "CodeActAgent", to: "AgentBase", kind: "inherits" },
      { op: "connect_class", view: "classes", from: "MCPAgent", to: "AgentBase", kind: "inherits" },
    ],
  },
  {
    id: "plan_execute_seq",
    label: "Plan-Execute sequence",
    view: "sequences",
    description: "A starter sequence: user → agent → planner → executor → tools and back.",
    params: [],
    build: () => [
      { op: "add_sequence", view: "sequences", name: "Plan-Execute" },
      { op: "add_participant", view: "sequences", seq: "Plan-Execute", label: "User" },
      { op: "add_participant", view: "sequences", seq: "Plan-Execute", label: "Agent" },
      { op: "add_participant", view: "sequences", seq: "Plan-Execute", label: "Planner" },
      { op: "add_participant", view: "sequences", seq: "Plan-Execute", label: "Executor" },
      { op: "add_participant", view: "sequences", seq: "Plan-Execute", label: "Tools" },
      { op: "add_message", view: "sequences", seq: "Plan-Execute", from: "User", to: "Agent", label: "query", type: "sync" },
      { op: "add_message", view: "sequences", seq: "Plan-Execute", from: "Agent", to: "Planner", label: "make plan", type: "sync" },
      { op: "add_message", view: "sequences", seq: "Plan-Execute", from: "Planner", to: "Agent", label: "plan", type: "return" },
      { op: "add_message", view: "sequences", seq: "Plan-Execute", from: "Agent", to: "Executor", label: "execute steps", type: "sync" },
      { op: "add_message", view: "sequences", seq: "Plan-Execute", from: "Executor", to: "Tools", label: "call tool", type: "sync" },
      { op: "add_message", view: "sequences", seq: "Plan-Execute", from: "Tools", to: "Executor", label: "result", type: "return" },
      { op: "add_message", view: "sequences", seq: "Plan-Execute", from: "Executor", to: "Agent", label: "results", type: "return" },
      { op: "add_message", view: "sequences", seq: "Plan-Execute", from: "Agent", to: "User", label: "response", type: "return" },
    ],
  },
];

const BY_ID = new Map(SKILLS.map((s) => [s.id, s]));
export const getSkill = (id) => BY_ID.get(id) || null;
export const skillView = (id) => (BY_ID.get(id)?.view) || "architecture";

export function buildSkill(id, params = {}) {
  const skill = BY_ID.get(id);
  if (!skill) throw new Error(`unknown skill "${id}"`);
  // Merge param defaults.
  const merged = {};
  for (const p of skill.params || []) merged[p.name] = params[p.name] !== undefined ? params[p.name] : p.default;
  return skill.build(merged);
}

// Compact skill list for the assistant's system prompt.
export function skillVocabulary() {
  return SKILLS.map((s) => {
    const params = (s.params || []).map((p) => p.name).join(", ");
    return `- ${s.id}${params ? ` (${params})` : ""}: ${s.description}`;
  }).join("\n");
}
