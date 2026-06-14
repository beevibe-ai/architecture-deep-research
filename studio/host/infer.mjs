// Infer the REAL architecture from a repo scan.
//
// This is the heart of reality-binding: instead of the human drawing boxes, the
// model reads the actual repo digest (manifests, deploy configs, directory
// structure, observability libs) and emits the architecture the code actually
// implements — every component grounded in a real file (cite-or-die). The host
// runs this into a fresh seed spec via the normal assistant loop, then diffs the
// result against the canvas to surface drift.

// Condense a full repo scan into a compact, high-signal prompt. The scanner's
// digest is rich; we keep the parts that reveal components and trim verbose docs
// so a single inference call stays well within context.
import { emptySpec, applyMutation } from "../shared/ir.mjs";
import { routeFactsFromSources } from "./extract.mjs";

export function architectureFromScan(scan, seed = emptySpec()) {
  let spec = seed;
  const apply = (m) => {
    try {
      spec = applyMutation(spec, m);
    } catch {
      /* best-effort baseline; skip facts that cannot map cleanly */
    }
  };

  const text = evidenceText(scan);
  const dirs = new Set((scan.tree || []).filter((t) => t.kind === "dir").map((t) => t.path.replace(/\\/g, "/")));
  const packageNames = new Set([...dirs].map((d) => /^packages\/([^/]+)$/.exec(d)?.[1]).filter(Boolean));
  const routes = routeFactsFromSources(scan.route_sources || []);
  const source = (...paths) => paths.filter(Boolean).join(", ");

  const add = (label, type, { tech = "", notes = "", context = "", parent = null, layer = null } = {}) => {
    if (!label || hasNode(spec, label)) return label;
    apply({ op: "add_node", view: "architecture", type, label, tech, notes, context, parent, layer });
    return label;
  };
  const connect = (from, to, { kind = "calls", protocol = "http", label = "" } = {}) => {
    if (!from || !to || from === to || hasEdge(spec, from, to, kind, protocol)) return;
    apply({ op: "connect", view: "architecture", from, to, kind, protocol, label });
  };

  const hasWeb = packageNames.has("web") || /\b(next|react)\b/i.test(text);
  const hasApi = packageNames.has("api") || routes.length > 0 || /\b(express|fastify|hono)\b/i.test(text);
  const hasDb = /\b(postgres|postgresql|pgvector|"pg"\s*:|node-postgres)\b/i.test(text);
  const hasPgvector = /\b(pgvector|vector\s*\()/i.test(text);
  const hasRedis = /\b(redis|ioredis)\b/i.test(text);
  const queueTech = firstMatch(text, [
    ["Kafka", /\b(kafkajs|kafka|redpanda)\b/i],
    ["NATS", /\b(nats)\b/i],
    ["RabbitMQ", /\b(rabbitmq|amqplib)\b/i],
    ["SQS", /\b(@aws-sdk\/client-sqs|sqs)\b/i],
  ]);
  const llmTech = ["Anthropic", "OpenAI", "DeepSeek"]
    .filter((name) => new RegExp(name === "OpenAI" ? "\\b(openai|gpt-)\\b" : name, "i").test(text));

  const web = hasWeb ? add("Web Client", "client", { tech: /\bnext\b/i.test(text) ? "Next.js" : "React", notes: source("packages/web", "package.json") }) : null;
  const api = hasApi ? add("API Service", "service", { tech: /\bexpress\b/i.test(text) ? "Express" : "Node.js", notes: source("packages/api", routes[0]?.file) }) : null;
  const runtimePackages = ["daemon", "scheduler", "executor", "sandbox"].filter((name) => packageNames.has(name));
  const runtime = runtimePackages.length
    ? add("Agent Runtime", "agent_runtime", {
        tech: "Node.js",
        notes: runtimePackages.map((name) => `packages/${name}`).join(", "),
        context: "Runtime boundary for background agents, scheduling, execution, and sandboxed work.",
      })
    : null;
  const runtimeId = runtime ? nodeId(spec, runtime) : null;
  const daemon = packageNames.has("daemon") ? add("Daemon", "worker", { tech: "Node.js", notes: "packages/daemon", parent: runtimeId }) : null;
  const scheduler = packageNames.has("scheduler") ? add("Scheduler", "scheduler", { tech: "Node.js", notes: "packages/scheduler", parent: runtimeId }) : null;
  const executor = packageNames.has("executor") ? add("Executor", "worker", { tech: "Node.js", notes: "packages/executor", parent: runtimeId }) : null;
  const mcp = packageNames.has("mcp-server") ? add("MCP Server", "mcp_server", { tech: "MCP", notes: "packages/mcp-server" }) : null;
  const sandbox = packageNames.has("sandbox") ? add("Sandbox", "worker", { tech: "Node.js", notes: "packages/sandbox", parent: runtimeId }) : null;
  const db = hasDb ? add("Postgres Database", "relational_db", { tech: hasPgvector ? "pgvector" : "Postgres", notes: source("docker-compose.yml", "migrations", "package.json") }) : null;
  const cache = hasRedis ? add("Redis Cache", "cache", { tech: "Redis", notes: "package/deploy config" }) : null;
  const queue = queueTech ? add(`${queueTech} Queue`, "event_queue", { tech: queueTech, notes: "package/deploy config" }) : null;
  const llm = llmTech.length ? add("LLM Provider", "llm_provider", { tech: llmTech.join(" / "), notes: "package.json" }) : null;

  connect(web, api, { protocol: "http" });
  if (routes.some((r) => r.sql_ops?.length)) connect(api, db, { protocol: "sql", label: "app state" });
  if (routes.some((r) => /^\/mcp\b/.test(r.path)) && !(runtime && executor)) connect(api, mcp, { protocol: "http", label: "/mcp" });
  if (routes.some((r) => r.notifications?.length)) connect(api, runtime, { kind: "publishes", protocol: "event", label: "via Postgres LISTEN/NOTIFY" });
  connect(api, cache, { protocol: "internal" });
  connect(api, queue, { kind: "publishes", protocol: "event" });
  connect(queue, runtime, { kind: "subscribes", protocol: "event" });
  connect(api, llm, { protocol: "http" });
  if (daemon || scheduler) connect(runtime || daemon || scheduler, db, { protocol: "sql", label: "runtime state" });
  if (executor && sandbox) connect(executor, sandbox, { protocol: "internal" });
  if (executor && mcp) connect(runtime || executor, mcp, { protocol: "internal", label: "tool calls" });

  if (spec.views.architecture.nodes.filter((n) => !n.parent).length > 1) {
    apply({ op: "auto_layout", view: "architecture", direction: "TB" });
  }
  return spec;
}

function evidenceText(scan) {
  return [
    ...(scan.manifests || []).map((m) => m.content || ""),
    ...(scan.deploy_configs || []).map((c) => c.content || ""),
    ...(scan.schema_sources || []).map((s) => s.content || ""),
    ...(scan.route_sources || []).map((s) => s.content || ""),
    ...(scan.docs || []).map((d) => d.content || ""),
  ].join("\n");
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function hasNode(spec, label) {
  const key = norm(label);
  return spec.views.architecture.nodes.some((n) => norm(n.label) === key);
}

function nodeId(spec, label) {
  const key = norm(label);
  return spec.views.architecture.nodes.find((n) => norm(n.label) === key)?.id || null;
}

function hasEdge(spec, fromLabel, toLabel, kind, protocol) {
  const from = nodeId(spec, fromLabel);
  const to = nodeId(spec, toLabel);
  if (!from || !to) return true;
  return spec.views.architecture.edges.some((e) => e.from === from && e.to === to && e.kind === kind && e.protocol === protocol);
}

function firstMatch(text, entries) {
  return entries.find(([, re]) => re.test(text))?.[0] || "";
}

export function digestForInference(scan) {
  const lines = [];
  lines.push(`Repo: ${scan.repo_path}`);
  if (scan.git_signals?.branch) lines.push(`Branch: ${scan.git_signals.branch}`);

  const dirs = (scan.tree || []).filter((t) => t.kind === "dir").map((t) => t.path);
  if (dirs.length) lines.push(`\nDirectory structure (modules/services live here):\n${dirs.slice(0, 60).map((d) => "  " + d).join("\n")}`);

  if (scan.manifests?.length) {
    lines.push(`\nPackage manifests (dependencies reveal tech — pg→Postgres, redis→cache, kafkajs→Kafka, @qdrant/*→vector store, openai/anthropic→LLM provider, express/fastify→service, next/react→client):`);
    for (const m of scan.manifests) {
      if (m.content === "[lockfile present]") continue;
      lines.push(`\n--- ${m.path} (${m.kind}) ---\n${trim(m.content, 1800)}`);
    }
  }

  if (scan.deploy_configs?.length) {
    lines.push(`\nDeploy configs (services, datastores, infra):`);
    for (const c of scan.deploy_configs) {
      lines.push(`\n--- ${c.path} (${c.platform}) ---\n${trim(c.content, 1200)}`);
    }
  }

  const routes = routeFactsFromSources(scan.route_sources || []);
  if (routes.length) {
    lines.push(`\nActual HTTP/API routes (grounded in server source; tables/dependencies show real behavior):`);
    for (const r of routes.slice(0, 60)) {
      const tables = summarizeSqlOps(r.sql_ops || []);
      const deps = (r.dependencies || []).map((d) => `${d.target}.${d.method}()`);
      const extra = [
        r.auth ? "auth" : "",
        tables.length ? `db=${tables.join(",")}` : "",
        deps.length ? `deps=${deps.slice(0, 5).join(",")}` : "",
        r.notifications?.length ? `notify=${r.notifications.join(",")}` : "",
        `source=${r.file}`,
      ].filter(Boolean).join("; ");
      lines.push(`  - ${r.method} ${r.path}${extra ? ` (${extra})` : ""}`);
    }
  }

  if (scan.observability_signals?.length) {
    lines.push(`\nObservability libraries detected: ${scan.observability_signals.map((o) => `${o.name} (${o.evidence_cite.join(", ")})`).join("; ")}`);
  }

  const archDoc = (scan.docs || []).find((d) => /ARCHITECTURE|DESIGN/i.test(d.path)) || (scan.docs || []).find((d) => /README/i.test(d.path));
  if (archDoc) lines.push(`\nArchitecture intent from ${archDoc.path}:\n${trim(archDoc.content, 1500)}`);

  return lines.join("\n");
}

function trim(s, max) {
  const str = String(s || "");
  return str.length <= max ? str : str.slice(0, max) + "\n[…truncated]";
}

function summarizeSqlOps(ops) {
  const byTable = new Map();
  for (const o of ops || []) {
    const set = byTable.get(o.table) || new Set();
    set.add(o.op);
    byTable.set(o.table, set);
  }
  return [...byTable.entries()].map(([table, verbs]) => `${[...verbs].join("/")}:${table}`);
}

// The instruction handed to the assistant. It must build ONLY the architecture
// view, only from evidenced components, and cite the grounding file in `notes`
// so drift can show where each claim came from.
export function inferenceInstruction(digest, { hasBaseline = false } = {}) {
  return [
    "You are reverse-engineering the architecture of a REAL codebase from its repo digest below.",
    "Reconstruct the system's actual architecture as it exists in the code — not an ideal design.",
    hasBaseline
      ? "A deterministic scanner has already seeded a coarse baseline in the current design. Refine, rename, annotate, remove, or rewire those existing components instead of duplicating them."
      : "",
    "",
    "Rules:",
    "- Add ONLY components you can ground in the digest (a dependency, a deploy service, a directory, a doc). Cite-or-die: do not invent components the evidence doesn't support.",
    "- For every component, put the grounding file path(s) in `notes` (e.g. notes: \"package.json, docker-compose.yml\"). This is the evidence drift will show.",
    "- Set `tech` to the concrete technology the code uses (pgvector, Kafka, Redis, Postgres, …) when the evidence names it.",
    "- Build on the architecture view only, using arch_add_node and arch_connect. Wire components by how they actually call each other. Keep it to the real top-level components, not every file.",
    "- Run auto_layout on architecture when done.",
    "- Then reply with one sentence: how many components you found and the overall shape.",
    "",
    "Repo digest:",
    digest,
  ].join("\n");
}
