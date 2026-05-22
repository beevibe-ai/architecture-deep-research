import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const VERSION = "0.2.0";
const MAX_PARALLEL_RESEARCH_AGENTS = 3;
const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ENTITY_HINTS = [
  "Vendor",
  "Facility",
  "Contract",
  "ContractClause",
  "Jurisdiction",
  "ShipmentLane",
  "RegulatoryChange",
  "Patient",
  "Case",
  "Claim",
  "Policy",
  "Evidence",
  "Document",
  "Account",
  "User",
  "Workspace",
  "Project",
  "Task",
  "Agent",
  "Memory",
  "SourceSpan"
];

const QUERY_SHAPE_RULES = [
  {
    name: "multi_hop_relational",
    patterns: [
      "multi-hop",
      "multi hop",
      "trace",
      "tracing",
      "dependency",
      "dependencies",
      "relationship",
      "relationships",
      "link",
      "links",
      "exposed",
      "impact",
      "ripple"
    ]
  },
  {
    name: "audit_traceability",
    patterns: [
      "audit",
      "traceability",
      "lineage",
      "source-backed",
      "compliance",
      "legal",
      "medical",
      "regulated"
    ]
  },
  {
    name: "exploratory_research",
    patterns: [
      "explore",
      "research",
      "investigate",
      "open-ended",
      "open ended",
      "compare",
      "discover"
    ]
  },
  {
    name: "self_contained_lookup",
    patterns: ["faq", "docs", "documentation", "lookup", "search", "support"]
  },
  {
    name: "transactional_state",
    patterns: [
      "transaction",
      "transactions",
      "state",
      "mutation",
      "workflow",
      "approval",
      "command",
      "aggregate",
      "aggregates",
      "source-of-truth",
      "source of truth"
    ]
  }
];

const COMPLIANCE_PATTERNS = [
  "audit",
  "compliance",
  "legal",
  "medical",
  "hipaa",
  "gdpr",
  "sox",
  "regulated",
  "privacy",
  "traceability",
  "lineage"
];

const CONTEXT_HINTS = [
  "Ingestion",
  "Extraction",
  "QueryOrchestration",
  "TraceabilityAudit",
  "KnowledgeGraph",
  "Document",
  "Search",
  "Policy",
  "Review",
  "Agent",
  "Memory"
];

function titleCase(value) {
  return String(value || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clampNumber(value, { min = 0, max = 1, fallback = 0 } = {}) {
  const numeric = finiteNumber(value, fallback);
  return Math.max(min, Math.min(max, numeric));
}

function normalizePolarity(value) {
  const raw = String(value || "").trim().toLowerCase();
  const normalized = slugify(raw);
  if (
    ["supports", "support", "supported", "positive", "positive_with_caution", "fit"].includes(
      normalized
    ) ||
    /\b(support|supports|supported|positive|benefit|fit|pro)\b/i.test(raw)
  ) {
    return "supports";
  }
  if (
    ["rejects", "reject", "rejected", "negative", "contraindicated"].includes(normalized) ||
    /\b(reject|rejects|rejected|negative|risk|limitation|against|con|unsafe)\b/i.test(raw)
  ) {
    return "rejects";
  }
  return "neutral";
}

function normalizeDecisionStatus(value) {
  const normalized = slugify(value);
  if (["approved", "superseded", "rejected"].includes(normalized)) return normalized;
  return "proposed";
}

function normalizeCandidateDecision(value, { candidateName, selectedTopology } = {}) {
  const candidateSlug = slugify(candidateName);
  const selectedSlug = slugify(selectedTopology);
  if (selectedSlug && selectedSlug !== "requires_human_architecture_review" && candidateSlug === selectedSlug) {
    return "selected";
  }

  const raw = String(value || "").toLowerCase();
  const normalized = slugify(raw);
  if (["selected", "rejected", "deferred"].includes(normalized)) return normalized;
  if (/\b(reject|rejected|unsafe|forbidden|not selected|not primary|avoid)\b/i.test(raw)) {
    return "rejected";
  }
  if (/\b(defer|deferred|consider|secondary|complementary|needs|requires validation)\b/i.test(raw)) {
    return "deferred";
  }
  return "deferred";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function flagValues(flags, key) {
  const value = flags[key];
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

function contentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function hasNegationBefore(content, index) {
  const window = content.slice(Math.max(0, index - 80), index).toLowerCase();
  return /\b(does not|do not|doesn't|don't|not|no|without|avoid|is not|are not|less important than)\b/.test(
    window
  );
}

function findEvidence(content, patterns) {
  const normalized = content.toLowerCase();
  return patterns.filter((pattern) => {
    const normalizedPattern = pattern.toLowerCase();
    let index = normalized.indexOf(normalizedPattern);

    while (index !== -1) {
      if (!hasNegationBefore(normalized, index)) return true;
      index = normalized.indexOf(normalizedPattern, index + normalizedPattern.length);
    }

    return false;
  });
}

function inferEntities(content, domain) {
  const combined = `${domain}\n${content}`;
  const direct = ENTITY_HINTS.filter((hint) =>
    new RegExp(`\\b${hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "i").test(
      combined
    )
  );

  const codeStyle = Array.from(
    combined.matchAll(/\b[A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+\b/g)
  ).map((match) => match[0]);

  return unique([...direct, ...codeStyle]).slice(0, 16);
}

function inferBoundedContexts(content, entities) {
  const contextMatches = CONTEXT_HINTS.filter((hint) =>
    new RegExp(`\\b${hint}\\b`, "i").test(content)
  ).map((hint) => `${hint}Context`);

  const defaults = [];
  if (entities.some((entity) => /Document|Contract|Policy|Evidence/i.test(entity))) {
    defaults.push("IngestionContext");
  }
  if (entities.some((entity) => /Vendor|Facility|Case|Patient|Claim|Jurisdiction/i.test(entity))) {
    defaults.push("DomainModelContext");
  }
  if (/graph|relationship|entity|multi-hop|multi hop/i.test(content)) {
    defaults.push("KnowledgeGraphContext");
  }
  if (/query|search|retrieval|answer/i.test(content)) {
    defaults.push("QueryOrchestrationContext");
  }
  if (/audit|traceability|lineage|citation|source/i.test(content)) {
    defaults.push("TraceabilityAuditContext");
  }

  return unique([...contextMatches, ...defaults]).slice(0, 10);
}

function inferQueryShapes(content) {
  return QUERY_SHAPE_RULES.map((rule) => ({
    name: rule.name,
    evidence: findEvidence(content, rule.patterns)
  })).filter((shape) => shape.evidence.length > 0);
}

function inferComplianceConstraints(content) {
  return findEvidence(content, COMPLIANCE_PATTERNS).map((item) => titleCase(item));
}

function inferOperationalEnvelope(content) {
  const latency = content.match(/\b(?:p9[59]|latency|sla)[^.\n]{0,80}/i)?.[0];
  const cost = content.match(/\b(?:cost|budget|spend)[^.\n]{0,80}/i)?.[0];
  const scale = content.match(/\b(?:scale|concurrent|throughput|users|documents|requests)[^.\n]{0,80}/i)?.[0];
  const availability = content.match(/\b(?:availability|uptime|reliability|failover)[^.\n]{0,80}/i)?.[0];

  return {
    latency: latency || "not_specified",
    cost: cost || "not_specified",
    scale: scale || "not_specified",
    availability: availability || "not_specified"
  };
}

function inferRiskInvariants(content) {
  const invariants = [];

  if (/audit|traceability|lineage|citation|source/i.test(content)) {
    invariants.push("Answers must resolve to source-backed evidence before being returned.");
  }
  if (/multi-hop|multi hop|relationship|dependency|graph|entity/i.test(content)) {
    invariants.push("The selected architecture must preserve explicit relationships between domain entities.");
  }
  if (/compliance|legal|medical|regulated|privacy/i.test(content)) {
    invariants.push("Compliance-critical flows must be deterministic, reviewable, and replayable.");
  }
  if (/agent|tool|open-ended|open ended|research/i.test(content)) {
    invariants.push("Agentic search must be bounded by workflow controls and must not silently mutate source-of-truth state.");
  }
  if (/bounded context|ddd|aggregate|ownership/i.test(content)) {
    invariants.push("Bounded contexts must communicate through explicit interfaces or domain events.");
  }
  if (/transaction|mutation|approval|source-of-truth|source of truth/i.test(content)) {
    invariants.push("Source-of-truth mutations must be explicit, reviewable, and separated from retrieval or answer generation.");
  }

  return invariants.length > 0
    ? invariants
    : ["The selected architecture must preserve the domain invariants stated in the source brief."];
}

function buildStrategicContext({ sourcePath, content, domain, decision }) {
  const entities = inferEntities(content, domain);
  const queryShapes = inferQueryShapes(content);

  return {
    version: VERSION,
    source: {
      path: sourcePath,
      content_hash: contentHash(content)
    },
    domain,
    decision,
    domain_entities: entities,
    bounded_contexts: inferBoundedContexts(content, entities),
    query_shapes:
      queryShapes.length > 0
        ? queryShapes
        : [{ name: "unspecified", evidence: ["No explicit query shape found."] }],
    risk_invariants: inferRiskInvariants(content),
    operational_envelope: inferOperationalEnvelope(content),
    compliance_constraints: inferComplianceConstraints(content),
    acquisition_contract: {
      mode: "live_agentic_research_required",
      no_static_pattern_oracle: true,
      no_offline_research_mode: true,
      candidate_architecture_families_source:
        "Candidates must be acquired from live research evidence and synthesis, not from a hard-coded pattern library."
    }
  };
}

function assessClarification(context, content) {
  const questions = [];

  if (content.length < 600) {
    questions.push("Could you provide more product context or a fuller PRD?");
  }
  if (context.domain_entities.length < 3) {
    questions.push("Which domain entities or aggregates must the architecture preserve?");
  }
  if (context.query_shapes[0]?.name === "unspecified") {
    questions.push("What are representative user questions or workflows the system must support?");
  }
  if (context.compliance_constraints.length === 0 && /legal|medical|finance|enterprise/i.test(context.domain)) {
    questions.push("Are there audit, lineage, privacy, or compliance requirements?");
  }
  if (Object.values(context.operational_envelope).every((value) => value === "not_specified")) {
    questions.push("What latency, cost, scale, or availability constraints should shape the decision?");
  }

  return {
    version: VERSION,
    needs_clarification: questions.length > 0,
    questions: questions.slice(0, 5),
    action:
      questions.length > 0
        ? "Proceed only if the caller accepts a lower-confidence research run or supplies the missing context."
        : "Enough context for Architecture Deep Research."
  };
}

function activeSearchProviders() {
  const providers = [];
  if (process.env.BRAVE_SEARCH_API_KEY) providers.push("brave");
  if (process.env.SERPER_API_KEY) providers.push("serper");
  if (process.env.TAVILY_API_KEY) providers.push("tavily");
  if (process.env.SEARXNG_URL) providers.push("searxng");
  if (
    process.env.ADR_MCP_SERVER_URL &&
    (process.env.OPENAI_API_KEY || process.env.ADR_OPENAI_API_KEY)
  ) {
    providers.push("openai-remote-mcp");
  }
  if (process.env.OPENAI_API_KEY || process.env.ADR_OPENAI_API_KEY) {
    providers.push("openai-web-search");
  }
  return providers;
}

let customLlmJsonProvider = null;
let customLlmProviderLabel = null;

function setLlmJsonProvider(fn, { label = "custom" } = {}) {
  if (fn !== null && typeof fn !== "function") {
    throw new Error("setLlmJsonProvider expects a function or null.");
  }
  customLlmJsonProvider = fn;
  customLlmProviderLabel = fn ? label : null;
}

function getLlmJsonProvider() {
  return customLlmJsonProvider;
}

function activeLlmProvider() {
  if (customLlmJsonProvider) return customLlmProviderLabel || "custom";
  const provider = process.env.ADR_LLM_PROVIDER || "openai-compatible";
  const baseUrl =
    process.env.ADR_OPENAI_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1";
  const apiKey = process.env.ADR_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (provider !== "openai-compatible") return null;
  if (!apiKey && !baseUrl.includes("localhost") && !baseUrl.includes("127.0.0.1")) {
    return null;
  }
  return provider;
}

function assertAgenticRuntime(flags = {}) {
  if (flags.offline || flags.fixture || flags.mock) {
    throw new Error(
      "Offline, fixture, and mock research modes are not supported. Architecture Deep Research requires live search plus an LLM synthesis provider."
    );
  }

  const searchProviders = activeSearchProviders();
  if (searchProviders.length === 0) {
    throw new Error(
      "No live search provider configured. Set BRAVE_SEARCH_API_KEY, SERPER_API_KEY, TAVILY_API_KEY, SEARXNG_URL, ADR_MCP_SERVER_URL with OPENAI_API_KEY/ADR_OPENAI_API_KEY, or OPENAI_API_KEY/ADR_OPENAI_API_KEY for OpenAI web_search before running Architecture Deep Research."
    );
  }

  const llmProvider = activeLlmProvider();
  if (!llmProvider) {
    throw new Error(
      "No LLM synthesis provider configured. Set ADR_OPENAI_API_KEY or OPENAI_API_KEY for the OpenAI-compatible runtime, or point ADR_OPENAI_BASE_URL at a local OpenAI-compatible server."
    );
  }

  return { searchProviders, llmProvider };
}

async function appendEvent(outDir, type, payload = {}) {
  await appendFile(
    path.join(outDir, "events.jsonl"),
    `${JSON.stringify({ ts: nowIso(), type, ...payload })}\n`
  );
}

const schemaByFilename = {
  "architecture.spec.json": "../docs/schemas/architecture-spec.schema.json",
  "claim-audit.json": "../docs/schemas/claim-audit.schema.json",
  "citation-audit.json": "../docs/schemas/citation-audit.schema.json",
  "clarification.json": "../docs/schemas/clarification.schema.json",
  "comparison-matrix.json": "../docs/schemas/comparison-matrix.schema.json",
  "critique.json": "../docs/schemas/critique.schema.json",
  "domain-evaluation-pack.json": "../docs/schemas/domain-evaluation-pack.schema.json",
  "evidence.json": "../docs/schemas/evidence.schema.json",
  "execution-handoff.json": "../docs/schemas/execution-handoff.schema.json",
  "knowledge-map.json": "../docs/schemas/knowledge-map.schema.json",
  "research-plan.json": "../docs/schemas/research-plan.schema.json",
  "strategic-context.json": "../docs/schemas/strategic-context.schema.json",
  "supersedes.json": "../docs/schemas/supersedes.schema.json"
};

let schemaValidatorState = null;

async function getSchemaValidators() {
  if (schemaValidatorState) return schemaValidatorState;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validators = new Map();
  for (const [filename, relativePath] of Object.entries(schemaByFilename)) {
    const schemaPath = path.resolve(__dirname, relativePath);
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    validators.set(filename, ajv.compile(schema));
  }
  schemaValidatorState = { ajv, validators };
  return schemaValidatorState;
}

async function assertSchemaValid(filename, value) {
  const { validators } = await getSchemaValidators();
  const validator = validators.get(filename);
  if (!validator) return;
  if (validator(value)) return;
  const errors = (validator.errors || [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .slice(0, 20)
    .join("; ");
  throw new Error(`schema invalid for ${filename}: ${errors}`);
}

// Per-million-token prices in USD. Approximate; update as providers change pricing.
// Models not in this table get usd estimates of null.
const LLM_PRICE_TABLE = {
  "gpt-4.1": { input: 2, output: 8, cached_input: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cached_input: 0.1 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cached_input: 0.025 },
  "gpt-4o": { input: 2.5, output: 10, cached_input: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cached_input: 0.075 },
  "gpt-5": { input: 1.25, output: 10, cached_input: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2, cached_input: 0.025 }
};

let llmCostState = { byPhase: new Map() };

function resetLlmCost() {
  llmCostState = { byPhase: new Map() };
}

function recordLlmCost({ label, model, usage }) {
  if (!usage) return;
  const key = `${label}::${model}`;
  const existing =
    llmCostState.byPhase.get(key) ||
    { label, model, calls: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
  existing.calls += 1;
  existing.input_tokens += Number(usage.prompt_tokens || usage.input_tokens || 0);
  existing.output_tokens += Number(usage.completion_tokens || usage.output_tokens || 0);
  const cached =
    usage.prompt_tokens_details?.cached_tokens ||
    usage.cached_tokens ||
    0;
  existing.cached_input_tokens += Number(cached);
  llmCostState.byPhase.set(key, existing);
}

function estimatePhaseUsd({ model, input_tokens, output_tokens, cached_input_tokens }) {
  const baseModel = String(model || "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const price = LLM_PRICE_TABLE[baseModel] || LLM_PRICE_TABLE[model];
  if (!price) return null;
  const nonCachedInput = Math.max(0, input_tokens - cached_input_tokens);
  const usd =
    (nonCachedInput / 1e6) * price.input +
    (cached_input_tokens / 1e6) * (price.cached_input ?? price.input) +
    (output_tokens / 1e6) * price.output;
  return Number(usd.toFixed(6));
}

function summarizeLlmCost() {
  const phases = [...llmCostState.byPhase.values()].map((p) => ({
    ...p,
    estimated_usd: estimatePhaseUsd(p)
  }));
  const totals = phases.reduce(
    (acc, p) => {
      acc.calls += p.calls;
      acc.input_tokens += p.input_tokens;
      acc.output_tokens += p.output_tokens;
      acc.cached_input_tokens += p.cached_input_tokens;
      if (p.estimated_usd !== null) acc.estimated_usd += p.estimated_usd;
      else acc.has_unpriced_models = true;
      return acc;
    },
    {
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      estimated_usd: 0,
      has_unpriced_models: false
    }
  );
  return {
    version: VERSION,
    note: "Estimates use the LLM_PRICE_TABLE in kernel.mjs. Providers change prices; treat these as ballpark.",
    totals: {
      calls: totals.calls,
      input_tokens: totals.input_tokens,
      output_tokens: totals.output_tokens,
      cached_input_tokens: totals.cached_input_tokens,
      estimated_usd: Number(totals.estimated_usd.toFixed(6)),
      has_unpriced_models: totals.has_unpriced_models
    },
    by_phase: phases.sort((a, b) => (b.estimated_usd || 0) - (a.estimated_usd || 0))
  };
}

async function callLlmJson({ system, user, label = "llm_json" }) {
  if (customLlmJsonProvider) {
    return customLlmJsonProvider({ system, user, label });
  }

  const provider = process.env.ADR_LLM_PROVIDER || "openai-compatible";
  if (provider !== "openai-compatible") {
    throw new Error(`Unsupported ADR_LLM_PROVIDER: ${provider}`);
  }

  const baseUrl =
    process.env.ADR_OPENAI_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1";
  const apiKey = process.env.ADR_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.ADR_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini";

  if (!apiKey && !baseUrl.includes("localhost") && !baseUrl.includes("127.0.0.1")) {
    throw new Error(`Cannot run ${label}: missing ADR_OPENAI_API_KEY or OPENAI_API_KEY.`);
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    }),
    signal: AbortSignal.timeout(Number(process.env.ADR_LLM_TIMEOUT_MS || 90_000))
  });

  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  recordLlmCost({ label, model, usage: payload.usage });
  const content = payload.choices?.[0]?.message?.content || "";
  try {
    return JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/i) || content.match(/({[\s\S]*})/);
    if (!jsonMatch) throw new Error(`${label} did not return parseable JSON.`);
    return JSON.parse(jsonMatch[1] || jsonMatch[0]);
  }
}

async function buildResearchPlan(context, content) {
  const result = await callLlmJson({
    label: "research_plan_agent",
    system: [
      "You are the planning agent for Architecture Deep Research.",
      "Create source-acquisition tasks for a strategic architecture decision.",
      "Do not choose the architecture yet.",
      "Do not rely on a static pattern library.",
      "Prefer official docs, mature OSS, engineering writeups, benchmark papers, and postmortems.",
      "Output JSON with: {tasks:[{id,title,objective,search_queries,source_targets,success_criteria}]}."
    ].join("\n"),
    user: JSON.stringify({
      domain: context.domain,
      decision: context.decision,
      strategic_context: context,
      product_context_excerpt: content.slice(0, 16_000)
    })
  });

  if (!Array.isArray(result.tasks) || result.tasks.length === 0) {
    throw new Error("Research planning agent returned no tasks.");
  }

  return {
    version: VERSION,
    architecture: "live_agentic_deep_research",
    max_parallel_research_agents: MAX_PARALLEL_RESEARCH_AGENTS,
    tasks: result.tasks.slice(0, 8).map((task, index) => ({
      id: task.id || `R${index + 1}`,
      title: task.title || `Research task ${index + 1}`,
      objective: task.objective || "Acquire architecture evidence.",
      search_queries: toArray(task.search_queries).slice(0, 5),
      source_targets: toArray(task.source_targets).slice(0, 8),
      success_criteria: toArray(task.success_criteria).slice(0, 5)
    }))
  };
}

function shouldPreferMcpSearch() {
  return (
    process.env.ADR_SEARCH_PROVIDER === "mcp" ||
    process.env.ADR_PRIVATE_MCP_ONLY === "1"
  );
}

async function searchWithOpenAiMcp(query) {
  const openaiKey = process.env.ADR_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const serverUrl = process.env.ADR_MCP_SERVER_URL;
  if (!openaiKey || !serverUrl) return null;

  const baseUrl =
    process.env.ADR_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.ADR_SEARCH_MODEL || process.env.ADR_MODEL || "gpt-4.1-mini";
  const serverLabel = process.env.ADR_MCP_SERVER_LABEL || "adr_private_corpus";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openaiKey}`
    },
    body: JSON.stringify({
      model,
      input: `Search the private architecture corpus for evidence relevant to: ${query}`,
      tools: [
        {
          type: "mcp",
          server_label: serverLabel,
          server_url: serverUrl,
          require_approval: "never"
        }
      ],
      tool_choice: "required"
    }),
    signal: AbortSignal.timeout(45_000)
  });
  if (!response.ok) {
    throw new Error(
      `OpenAI remote MCP search failed: ${response.status} ${await response.text().catch(() => "")}`
    );
  }

  const body = await response.json();
  const seen = new Set();
  const results = [];
  let fallbackText = "";
  for (const out of body.output || []) {
    if (out.type !== "message") continue;
    for (const block of out.content || []) {
      const text = block.text || "";
      fallbackText += `${text}\n`;
      for (const ann of block.annotations || []) {
        if (ann.type !== "url_citation" || !ann.url) continue;
        const canonical = ann.url;
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        const start = Number.isInteger(ann.start_index) ? ann.start_index : 0;
        const end = Number.isInteger(ann.end_index) ? ann.end_index : text.length;
        results.push({
          title: ann.title || canonical,
          url: canonical,
          snippet: text.slice(start, end).trim(),
          provider: "openai-remote-mcp"
        });
        if (results.length >= 8) break;
      }
      if (results.length >= 8) break;
    }
    if (results.length >= 8) break;
  }
  if (results.length > 0) return results;
  console.warn(
    `[search] openai-remote-mcp returned no url_citation annotations for "${query.slice(0, 80)}" — yielding 0 results (no fabricated evidence).`
  );
  return [];
}

async function searchWithProvider(query) {
  if (shouldPreferMcpSearch()) {
    const mcpResults = await searchWithOpenAiMcp(query);
    if (mcpResults) return mcpResults;
  }

  if (process.env.BRAVE_SEARCH_API_KEY) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", "8");
    const response = await fetch(url, {
      headers: { "x-subscription-token": process.env.BRAVE_SEARCH_API_KEY },
      signal: AbortSignal.timeout(25_000)
    });
    if (!response.ok) throw new Error(`Brave search failed: ${response.status}`);
    const body = await response.json();
    return (body.web?.results || []).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.description || "",
      provider: "brave"
    }));
  }

  if (process.env.SERPER_API_KEY) {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.SERPER_API_KEY
      },
      body: JSON.stringify({ q: query, num: 8 }),
      signal: AbortSignal.timeout(25_000)
    });
    if (!response.ok) throw new Error(`Serper search failed: ${response.status}`);
    const body = await response.json();
    return (body.organic || []).map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet || "",
      provider: "serper"
    }));
  }

  if (process.env.TAVILY_API_KEY) {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results: 8,
        search_depth: "advanced"
      }),
      signal: AbortSignal.timeout(25_000)
    });
    if (!response.ok) throw new Error(`Tavily search failed: ${response.status}`);
    const body = await response.json();
    return (body.results || []).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.content || "",
      provider: "tavily"
    }));
  }

  if (process.env.SEARXNG_URL) {
    const url = new URL(process.env.SEARXNG_URL.replace(/\/$/, "") + "/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new Error(`SearXNG search failed: ${response.status}`);
    const body = await response.json();
    return (body.results || []).slice(0, 8).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.content || "",
      provider: "searxng"
    }));
  }

  const mcpResults = await searchWithOpenAiMcp(query);
  if (mcpResults) return mcpResults;

  const openaiKey = process.env.ADR_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    const baseUrl =
      process.env.ADR_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const model = process.env.ADR_SEARCH_MODEL || process.env.ADR_MODEL || "gpt-4.1-mini";
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${openaiKey}`
      },
      body: JSON.stringify({
        model,
        input: query,
        tools: [{ type: "web_search" }],
        tool_choice: "required"
      }),
      signal: AbortSignal.timeout(45_000)
    });
    if (!response.ok) {
      throw new Error(
        `OpenAI web_search failed: ${response.status} ${await response.text().catch(() => "")}`
      );
    }
    const body = await response.json();
    const seen = new Set();
    const results = [];
    for (const out of body.output || []) {
      if (out.type !== "message") continue;
      for (const block of out.content || []) {
        const text = block.text || "";
        for (const ann of block.annotations || []) {
          if (ann.type !== "url_citation" || !ann.url) continue;
          const canonical = ann.url.replace(/[?&]utm_source=openai\b/, "");
          if (seen.has(canonical)) continue;
          seen.add(canonical);
          const start = Number.isInteger(ann.start_index) ? ann.start_index : 0;
          const end = Number.isInteger(ann.end_index) ? ann.end_index : text.length;
          results.push({
            title: ann.title || canonical,
            url: canonical,
            snippet: text.slice(start, end).trim(),
            provider: "openai-web-search"
          });
          if (results.length >= 8) break;
        }
        if (results.length >= 8) break;
      }
      if (results.length >= 8) break;
    }
    if (results.length === 0) {
      console.warn(
        `[search] openai-web-search returned no url_citation annotations for "${query.slice(0, 80)}" — yielding 0 results.`
      );
    }
    return results;
  }

  throw new Error("No live search provider configured.");
}

function htmlToText(html) {
  return normalizeWhitespace(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
  );
}

async function openUrl(url, flags) {
  if (!/^https?:\/\//i.test(url)) return "";

  const response = await fetch(url, {
    headers: {
      "user-agent": "Beevibe-ADR/0.2 (+https://github.com/beevibe-ai/architecture-deep-research)"
    },
    signal: AbortSignal.timeout(Number(flags["fetch-timeout-ms"] || 20_000))
  });
  if (!response.ok) return "";
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  return contentType.includes("html") ? htmlToText(text) : normalizeWhitespace(text);
}

function parseGithubRepoUrl(url) {
  const match = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^\/?#]+)\/([^\/?#]+)/i);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/, "");
  if (
    [
      "orgs",
      "topics",
      "search",
      "settings",
      "marketplace",
      "sponsors",
      "explore",
      "trending",
      "notifications",
      "issues",
      "pulls",
      "discussions",
      "collections",
      "events",
      "features"
    ].includes(owner.toLowerCase())
  ) {
    return null;
  }
  return { owner, repo };
}

function isGithubRepoUrl(url) {
  return parseGithubRepoUrl(url) !== null;
}

const FAILURE_MODE_KEYWORDS = [
  "regression",
  "incident",
  "outage",
  "latency",
  "slow",
  "performance",
  "memory leak",
  "leak",
  "crash",
  "panic",
  "data loss",
  "stuck",
  "hang",
  "deadlock",
  "race",
  "broken",
  "production"
];

async function githubApi(pathSuffix, flags) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "Beevibe-ADR/0.2 (+https://github.com/beevibe-ai/architecture-deep-research)",
    "x-github-api-version": "2022-11-28"
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(`https://api.github.com${pathSuffix}`, {
    headers,
    signal: AbortSignal.timeout(Number(flags["fetch-timeout-ms"] || 20_000))
  });
  if (!response.ok) {
    if (response.status === 404) return null;
    if (response.status === 403 || response.status === 429) {
      const hint = process.env.GITHUB_TOKEN
        ? "authenticated 5000/hr limit hit; retry later"
        : "set GITHUB_TOKEN to raise from 60/hr to 5000/hr";
      console.warn(`[github] ${response.status} ${pathSuffix} — ${hint}`);
      return null;
    }
    throw new Error(`GitHub API ${pathSuffix} failed: ${response.status}`);
  }
  return response.json();
}

function encodeGithubContentPath(filePath) {
  return String(filePath || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function fetchGithubFile({ owner, repo, filename, flags }) {
  if (!filename) return null;
  const data = await githubApi(
    `/repos/${owner}/${repo}/contents/${encodeGithubContentPath(filename)}`,
    flags
  ).catch(() => null);
  if (!data || !data.content) return null;
  try {
    return Buffer.from(data.content, data.encoding || "base64").toString("utf8");
  } catch {
    return null;
  }
}

async function listGithubDirectory({ owner, repo, dir, flags }) {
  const data = await githubApi(
    `/repos/${owner}/${repo}/contents/${encodeGithubContentPath(dir)}`,
    flags
  ).catch(() => null);
  return Array.isArray(data) ? data : [];
}

async function inspectGithubRepo(url, flags) {
  const parsed = parseGithubRepoUrl(url);
  if (!parsed) return null;
  const { owner, repo } = parsed;

  const meta = await githubApi(`/repos/${owner}/${repo}`, flags).catch(() => null);
  if (!meta) return null;

  const [contentsRaw, issuesRaw] = await Promise.allSettled([
    githubApi(`/repos/${owner}/${repo}/contents/`, flags),
    githubApi(
      `/repos/${owner}/${repo}/issues?state=closed&sort=updated&per_page=30`,
      flags
    )
  ]);

  const topLevel =
    contentsRaw.status === "fulfilled" && Array.isArray(contentsRaw.value)
      ? contentsRaw.value
          .map((entry) => ({ name: entry.name, type: entry.type }))
          .slice(0, 40)
      : [];

  const readmeFile = topLevel.find((entry) => /^readme(\.|$)/i.test(entry.name))?.name;
  const archFile = topLevel.find(
    (entry) =>
      /^architecture(\.|$)/i.test(entry.name) ||
      /^design(\.|$)/i.test(entry.name) ||
      /^docs$/i.test(entry.name)
  )?.name;
  const docsDir = topLevel.find((entry) => /^docs$/i.test(entry.name) && entry.type === "dir");
  const docsEntries = docsDir
    ? (await listGithubDirectory({ owner, repo, dir: docsDir.name, flags })).slice(0, 80)
    : [];
  const architectureDocPaths = unique([
    archFile && !/^docs$/i.test(archFile) ? archFile : null,
    ...docsEntries
      .filter((entry) => entry.type === "file")
      .filter((entry) =>
        /(?:architecture|architectural|design|adr|decision|retrieval|rag|graph|index|system|overview).*\.md$/i.test(
          entry.name
        )
      )
      .map((entry) => `${docsDir?.name || "docs"}/${entry.name}`)
  ]).slice(0, 5);

  const [readme, architectureDocs] = await Promise.all([
    fetchGithubFile({ owner, repo, filename: readmeFile, flags }),
    Promise.all(
      architectureDocPaths.map(async (filename) => ({
        filename,
        content: await fetchGithubFile({ owner, repo, filename, flags })
      }))
    )
  ]);
  const architectureSources = architectureDocs
    .filter((entry) => entry.content)
    .map((entry) => entry.filename);
  const architecture = architectureDocs
    .filter((entry) => entry.content)
    .map((entry) => `== ${entry.filename} ==\n${entry.content}`)
    .join("\n\n");

  const failureModeIssues =
    issuesRaw.status === "fulfilled" && Array.isArray(issuesRaw.value)
      ? issuesRaw.value
          .filter((issue) => !issue.pull_request)
          .filter((issue) => {
            const text = `${issue.title || ""} ${(issue.body || "").slice(0, 800)}`.toLowerCase();
            return FAILURE_MODE_KEYWORDS.some((kw) => text.includes(kw));
          })
          .slice(0, 8)
          .map((issue) => ({
            title: String(issue.title || ""),
            url: issue.html_url,
            state: issue.state,
            updated_at: issue.updated_at,
            labels: toArray(issue.labels)
              .map((label) => (typeof label === "string" ? label : label?.name))
              .filter(Boolean)
              .slice(0, 6)
          }))
      : [];

  return {
    url,
    owner,
    repo,
    full_name: meta.full_name,
    description: meta.description || "",
    stars: Number(meta.stargazers_count || 0),
    forks: Number(meta.forks_count || 0),
    open_issues: Number(meta.open_issues_count || 0),
    archived: Boolean(meta.archived),
    last_pushed_at: meta.pushed_at || null,
    default_branch: meta.default_branch || null,
    license: meta.license?.spdx_id || null,
    topics: toArray(meta.topics).slice(0, 12),
    top_level_files: topLevel,
    architecture_sources: architectureSources,
    readme_excerpt: readme
      ? normalizeWhitespace(readme).slice(0, 4000)
      : null,
    architecture_excerpt: architecture
      ? normalizeWhitespace(architecture).slice(0, 4000)
      : null,
    failure_mode_issues: failureModeIssues
  };
}

function isPaperUrl(url) {
  return /^https?:\/\/(?:www\.)?(?:arxiv\.org|openreview\.net|aclanthology\.org|aclweb\.org|dl\.acm\.org|ieee\.org|ieeexplore\.ieee\.org|papers\.ssrn\.com|biorxiv\.org|medrxiv\.org)\//i.test(
    url
  );
}

function arxivIdFromUrl(url) {
  const match = url.match(/arxiv\.org\/(?:abs|pdf)\/([\w.\-]+)(?:v\d+)?/i);
  return match ? match[1].replace(/\.pdf$/, "").replace(/v\d+$/i, "") : null;
}

async function fetchArxivAbstract(url, flags) {
  const id = arxivIdFromUrl(url);
  if (!id) return null;
  try {
    const response = await fetch(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`,
      {
        headers: {
          "user-agent": "Beevibe-ADR/0.2 (+https://github.com/beevibe-ai/architecture-deep-research)"
        },
        signal: AbortSignal.timeout(Number(flags["fetch-timeout-ms"] || 20_000))
      }
    );
    if (!response.ok) return null;
    const xml = await response.text();
    const title = xml.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/i)?.[1] || "";
    const summary = xml.match(/<entry>[\s\S]*?<summary>([\s\S]*?)<\/summary>/i)?.[1] || "";
    const authorsRaw = [...xml.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)];
    const authors = authorsRaw.map((match) => normalizeWhitespace(match[1])).slice(0, 12);
    const published = xml.match(/<entry>[\s\S]*?<published>([\s\S]*?)<\/published>/i)?.[1] || "";
    const primaryCategory =
      xml.match(/<arxiv:primary_category[^>]*term="([^"]+)"/i)?.[1] || "";
    return {
      id,
      title: normalizeWhitespace(title),
      abstract: normalizeWhitespace(summary),
      authors,
      published: normalizeWhitespace(published),
      primary_category: primaryCategory
    };
  } catch {
    return null;
  }
}

async function fetchPaperPageText(url, flags) {
  const text = await openUrl(url, flags).catch(() => "");
  return text ? text.slice(0, 12_000) : "";
}

function arxivHtmlUrl(id) {
  return id ? `https://ar5iv.labs.arxiv.org/html/${encodeURIComponent(id)}` : null;
}

function paperPdfUrl(url) {
  const arxivId = arxivIdFromUrl(url);
  if (arxivId) return `https://arxiv.org/pdf/${encodeURIComponent(arxivId)}`;
  if (/\.pdf(?:$|[?#])/i.test(url)) return url;
  return null;
}

async function fetchPdfText(url, flags) {
  const pdfUrl = paperPdfUrl(url);
  if (!pdfUrl) return "";
  let tempPath = null;
  try {
    const response = await fetch(pdfUrl, {
      headers: {
        "user-agent": "Beevibe-ADR/0.2 (+https://github.com/beevibe-ai/architecture-deep-research)"
      },
      signal: AbortSignal.timeout(Number(flags["fetch-timeout-ms"] || 20_000))
    });
    if (!response.ok) return "";
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) return "";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "adr-paper-"));
    tempPath = path.join(tempDir, "paper.pdf");
    await writeFile(tempPath, bytes);
    const { stdout } = await execFileAsync("pdftotext", ["-layout", tempPath, "-"], {
      timeout: Number(flags["pdf-timeout-ms"] || 20_000),
      maxBuffer: 8 * 1024 * 1024
    });
    return normalizeWhitespace(stdout).slice(0, 40_000);
  } catch {
    return "";
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => {});
  }
}

function filterMeasuredResultsForScope(results, sourceText, digestScope) {
  const normalizedSource = normalizeWhitespace(sourceText).toLowerCase();
  return toArray(results)
    .map(String)
    .filter((result) => {
      if (digestScope !== "abstract_only") return true;
      const numbers = result.match(/\d+(?:\.\d+)?%?/g) || [];
      if (numbers.length === 0) return false;
      return numbers.some((number) => normalizedSource.includes(number.toLowerCase()));
    })
    .slice(0, 8);
}

async function digestPaper(url, { context, task, flags }) {
  let arxivMeta = null;
  let pageText = "";
  let digestScope = "page_text";

  if (/arxiv\.org/i.test(url)) {
    arxivMeta = await fetchArxivAbstract(url, flags);
    const htmlUrl = arxivHtmlUrl(arxivMeta?.id);
    if (htmlUrl) {
      pageText = await openUrl(htmlUrl, flags).catch(() => "");
      if (pageText) digestScope = "full_text_html";
    }
    if (!pageText) {
      pageText = await fetchPdfText(url, flags);
      if (pageText) digestScope = "full_text_pdf";
    }
  }
  if (!arxivMeta) {
    pageText = await fetchPaperPageText(url, flags);
    if (pageText) digestScope = "page_text";
    if (!pageText) {
      pageText = await fetchPdfText(url, flags);
      if (pageText) digestScope = "full_text_pdf";
    }
    if (!pageText) return null;
  }
  if (arxivMeta && !pageText) digestScope = "abstract_only";

  const sourceTextForDigest = pageText || arxivMeta?.abstract || "";
  const sourcePayload = arxivMeta
    ? {
        kind: "arxiv",
        digest_scope: digestScope,
        id: arxivMeta.id,
        title: arxivMeta.title,
        abstract: arxivMeta.abstract,
        text: pageText ? pageText.slice(0, 24_000) : "",
        authors: arxivMeta.authors,
        published: arxivMeta.published,
        primary_category: arxivMeta.primary_category
      }
    : { kind: "web_paper", digest_scope: digestScope, url, text: pageText.slice(0, 24_000) };

  let digest;
  try {
    digest = await callLlmJson({
      label: "paper_digest_extractor",
      system: [
        "You extract a structured digest of a research paper from the supplied abstract or page text.",
        "Be conservative: only fill fields the source supports. Empty arrays / empty strings when missing.",
        "Distinguish 'headline_results' (what the abstract claims) from 'measured_results' (specific numbers actually reported).",
        "If digest_scope is 'abstract_only', measured_results may include only explicit measurements present in the abstract.",
        "conflicts_of_interest: list industry affiliations or funding that bias the claims, plus 'none_apparent' if none seen.",
        "Output JSON with {title,problem,methodology,datasets,baselines,headline_results,measured_results,ablations,limitations,conflicts_of_interest,relevant_to_decision}."
      ].join("\n"),
      user: JSON.stringify({
        decision_domain: context.domain,
        decision: context.decision,
        task_objective: task.objective,
        source: sourcePayload
      })
    });
  } catch {
    return null;
  }

  return {
    url,
    venue: arxivMeta ? "arxiv" : "web_paper",
    digest_scope: digestScope,
    title: String(digest.title || arxivMeta?.title || "").trim(),
    authors: toArray(arxivMeta?.authors).slice(0, 12),
    published: arxivMeta?.published || null,
    primary_category: arxivMeta?.primary_category || null,
    problem: String(digest.problem || "").trim(),
    methodology: String(digest.methodology || "").trim(),
    datasets: toArray(digest.datasets).map(String).slice(0, 12),
    baselines: toArray(digest.baselines).map(String).slice(0, 12),
    headline_results: toArray(digest.headline_results).map(String).slice(0, 8),
    measured_results: filterMeasuredResultsForScope(
      digest.measured_results,
      sourceTextForDigest,
      digestScope
    ),
    ablations: toArray(digest.ablations).map(String).slice(0, 8),
    limitations: toArray(digest.limitations).map(String).slice(0, 8),
    conflicts_of_interest: toArray(digest.conflicts_of_interest).map(String).slice(0, 6),
    relevant_to_decision: String(digest.relevant_to_decision || "").trim(),
    abstract: arxivMeta?.abstract || null
  };
}

function formatPaperDigestAsText(digest) {
  const lines = [
    `Paper: ${digest.title}`,
    digest.digest_scope ? `Digest scope: ${digest.digest_scope}` : null,
    digest.authors.length > 0 ? `Authors: ${digest.authors.join(", ")}` : null,
    digest.published ? `Published: ${digest.published}` : null,
    digest.primary_category ? `Category: ${digest.primary_category}` : null,
    digest.problem ? `Problem: ${digest.problem}` : null,
    digest.methodology ? `Methodology: ${digest.methodology}` : null,
    digest.datasets.length > 0 ? `Datasets: ${digest.datasets.join(", ")}` : null,
    digest.baselines.length > 0 ? `Baselines: ${digest.baselines.join(", ")}` : null,
    digest.headline_results.length > 0
      ? `Headline results: ${digest.headline_results.join("; ")}`
      : null,
    digest.measured_results.length > 0
      ? `Measured results: ${digest.measured_results.join("; ")}`
      : null,
    digest.ablations.length > 0 ? `Ablations: ${digest.ablations.join("; ")}` : null,
    digest.limitations.length > 0 ? `Limitations: ${digest.limitations.join("; ")}` : null,
    digest.conflicts_of_interest.length > 0
      ? `Conflicts of interest: ${digest.conflicts_of_interest.join("; ")}`
      : null,
    digest.relevant_to_decision
      ? `Relevance to decision: ${digest.relevant_to_decision}`
      : null,
    digest.abstract ? `Abstract: ${digest.abstract}` : null
  ].filter(Boolean);
  return normalizeWhitespace(lines.join("\n"));
}

function formatRepoDigestAsText(digest) {
  const lines = [
    `Repository: ${digest.full_name}`,
    `Description: ${digest.description || "(none)"}`,
    `Stars: ${digest.stars}; Forks: ${digest.forks}; Open issues: ${digest.open_issues}; Archived: ${digest.archived ? "yes" : "no"}`,
    `Last push: ${digest.last_pushed_at || "unknown"}; License: ${digest.license || "unknown"}`,
    digest.topics.length > 0 ? `Topics: ${digest.topics.join(", ")}` : null,
    digest.top_level_files.length > 0
      ? `Top-level entries: ${digest.top_level_files.map((entry) => entry.name).join(", ")}`
      : null,
    toArray(digest.architecture_sources).length > 0
      ? `Architecture docs inspected: ${digest.architecture_sources.join(", ")}`
      : null
  ].filter(Boolean);
  if (digest.readme_excerpt) {
    lines.push("", "== README excerpt ==", digest.readme_excerpt);
  }
  if (digest.architecture_excerpt) {
    lines.push("", "== ARCHITECTURE excerpt ==", digest.architecture_excerpt);
  }
  if (digest.failure_mode_issues.length > 0) {
    lines.push("", "== Recent failure-mode issues ==");
    for (const issue of digest.failure_mode_issues) {
      lines.push(`- ${issue.title} [${issue.state}] (${issue.url})`);
    }
  }
  return normalizeWhitespace(lines.join("\n"));
}

function extractExcerpt(text, keywords) {
  const clean = normalizeWhitespace(text).slice(0, 60_000);
  const lower = clean.toLowerCase();
  const keyword = keywords.find((item) => lower.includes(String(item).toLowerCase()));
  if (!keyword) return clean.slice(0, 1200);
  const index = Math.max(0, lower.indexOf(String(keyword).toLowerCase()) - 400);
  return clean.slice(index, index + 1600);
}

async function persistSourceSnapshot({ outDir, url, title, sourceType, fetchStatus, sourceText }) {
  const clean = normalizeWhitespace(sourceText || "");
  if (!outDir || !clean) {
    return {
      retrieved_at: nowIso(),
      fetch_status: fetchStatus || "empty",
      content_hash: contentHash(clean),
      raw_text_path: null,
      raw_text_bytes: 0
    };
  }
  const hash = contentHash(clean);
  const id = `${hash.slice(0, 16)}-${slugify(title || url).slice(0, 48) || "source"}`;
  const relativePath = path.join("source-snapshots", `${id}.txt`);
  const absolutePath = path.join(outDir, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    [
      `URL: ${url}`,
      `Title: ${title || ""}`,
      `Source type: ${sourceType || "unknown"}`,
      `Fetch status: ${fetchStatus || "unknown"}`,
      `Retrieved at: ${nowIso()}`,
      `Content SHA-256: ${hash}`,
      "",
      clean
    ].join("\n")
  );
  return {
    retrieved_at: nowIso(),
    fetch_status: fetchStatus || "unknown",
    content_hash: hash,
    raw_text_path: relativePath,
    raw_text_bytes: Buffer.byteLength(clean, "utf8")
  };
}

function classifySource(url) {
  if (!url) return "unknown";
  if (/^mcp:\/\//i.test(url)) return "private_corpus";
  if (/docs\.|microsoft\.github\.io|langchain|llamaindex|neo4j\.com|cloud\.google|openai\.com\/docs/i.test(url)) {
    return "official_docs";
  }
  if (/github\.com/i.test(url)) return "mature_oss";
  if (/arxiv|doi\.org|acm\.org|ieee|usenix|springer|scitepress/i.test(url)) return "paper_or_benchmark";
  if (/engineering|blog|netflix|uber|airbnb|doordash|stripe|shopify|figma|onyx\.app/i.test(url)) {
    return "engineering_writeup";
  }
  return "general_web";
}

function sourceQuality(sourceType) {
  return {
    official_docs: 0.95,
    mature_oss: 0.85,
    paper_or_benchmark: 0.85,
    private_corpus: 0.8,
    engineering_writeup: 0.78,
    general_web: 0.45,
    unknown: 0.25
  }[sourceType] || 0.35;
}

function evidenceKeywords(context, task) {
  return unique([
    ...context.domain_entities,
    ...context.query_shapes.map((shape) => shape.name.replace(/_/g, " ")),
    ...String(task.objective).split(/\W+/).filter((item) => item.length > 6),
    ...toArray(task.source_targets),
    "architecture",
    "retrieval",
    "workflow",
    "graph",
    "agent",
    "traceability",
    "citation",
    "bounded context"
  ]).slice(0, 32);
}

function scoreEvidence({ sourceType, excerpt, context, task, claims }) {
  const lower = `${excerpt} ${task.objective}`.toLowerCase();
  const keywordHits = evidenceKeywords(context, task).filter((keyword) =>
    lower.includes(String(keyword).toLowerCase())
  );
  const claimConfidence =
    claims.length === 0
      ? 0
      : claims.reduce((sum, claim) => sum + clampNumber(claim.confidence, { fallback: 0 }), 0) /
        claims.length;
  const score =
    sourceQuality(sourceType) * 0.45 +
    Math.min(keywordHits.length / 12, 1) * 0.25 +
    Math.min(claims.length / 4, 1) * 0.15 +
    claimConfidence * 0.15;
  return {
    keyword_hits: keywordHits,
    score: Number(score.toFixed(3))
  };
}

async function extractClaims({ context, task, source }) {
  const result = await callLlmJson({
    label: "source_claim_extractor",
    system: [
      "You extract architecture-decision evidence from sources.",
      "Return only claims that are directly supported by the supplied excerpt.",
      "Do not add static architecture knowledge.",
      "",
      "CRITICAL: architecture_family must name a MACRO-level architectural family,",
      "not a sub-component, algorithm, index type, library, or runtime step.",
      "Roll up low-level concepts under their parent macro family. Examples:",
      "- 'Leiden Community Detection', 'Hierarchical Clustering', 'MapReduce Summarization'",
      "  → architecture_family: 'GraphRAG'",
      "- 'Top-K Vector Search', 'HNSW Index', 'BM25 Reranker'",
      "  → architecture_family: 'Vector RAG' (or 'Hybrid RAG' if combined with graph)",
      "- 'ReAct Tool Use', 'Orchestrator-Worker', 'CitationAgent'",
      "  → architecture_family: 'Agentic Retrieval'",
      "",
      `Every architecture_family must be a valid candidate for the decision focus: "${context.decision}".`,
      "If a claim describes a sub-component or runtime step without a clear macro family,",
      "or if the claim is about something outside the decision focus, set architecture_family: 'unspecified'.",
      "Prefer canonical macro names. Do not invent new family names when a canonical one fits.",
      "",
      "polarity MUST be exactly one of: supports, rejects, neutral.",
      "confidence MUST be a number from 0 to 1.",
      "Output JSON with {claims:[{claim, architecture_family, polarity, domain_conditions, risk_or_fit, confidence}]}."
    ].join("\n"),
    user: JSON.stringify({
      domain: context.domain,
      decision: context.decision,
      task,
      source: {
        title: source.title,
        url: source.url,
        source_type: source.source_type,
        excerpt: source.excerpt
      }
    })
  });

  return toArray(result.claims)
    .map((claim) => ({
      claim: String(claim.claim || "").trim(),
      architecture_family: String(claim.architecture_family || "unspecified").trim(),
      polarity: normalizePolarity(claim.polarity),
      domain_conditions: toArray(claim.domain_conditions).map(String).slice(0, 6),
      risk_or_fit: String(claim.risk_or_fit || "").trim(),
      confidence: clampNumber(claim.confidence, { min: 0, max: 1, fallback: 0.5 })
    }))
    .filter((claim) => claim.claim);
}

async function judgeResearchProgress({ task, evidence, alreadyQueried }) {
  if (evidence.length === 0) {
    return { complete: false, reason: "no evidence yet", next_queries: [] };
  }
  try {
    const result = await callLlmJson({
      label: "research_completeness_judge",
      system: [
        "You decide whether a research task has gathered enough evidence to answer its objective.",
        "Be conservative: return complete:true only when the evidence clearly supports a strong answer.",
        "If incomplete, propose 1-3 new web search queries that fill the specific gaps.",
        "Do not repeat queries already tried.",
        "Output JSON with {complete, reason, next_queries:[string]}."
      ].join("\n"),
      user: JSON.stringify({
        task: { id: task.id, title: task.title, objective: task.objective },
        already_queried: alreadyQueried,
        evidence: evidence.map((item) => ({
          title: item.title,
          url: item.url,
          source_type: item.source_type,
          score: item.score,
          claims: (item.claims || []).map((claim) => claim.claim).slice(0, 4)
        }))
      })
    });
    return {
      complete: Boolean(result.complete),
      reason: String(result.reason || ""),
      next_queries: toArray(result.next_queries).map(String).slice(0, 3)
    };
  } catch (error) {
    return {
      complete: false,
      reason: `judge_failed: ${String(error?.message || error)}`,
      next_queries: []
    };
  }
}

async function gatherEvidenceForQuery({
  query,
  task,
  context,
  flags,
  keywords,
  seenUrls,
  evidence,
  round,
  maxSources,
  outDir
}) {
  const liveResults = await searchWithProvider(query);
  for (const result of liveResults) {
    if (!result.url || seenUrls.has(result.url)) continue;
    seenUrls.add(result.url);

    const source_type = classifySource(result.url);

    let repoDigest = null;
    let paperDigest = null;
    let sourceText = "";
    let fetchStatus = "search_snippet_only";
    if (isGithubRepoUrl(result.url)) {
      repoDigest = await inspectGithubRepo(result.url, flags).catch(() => null);
      if (repoDigest) {
        sourceText = formatRepoDigestAsText(repoDigest);
        fetchStatus = "github_api_ok";
      }
    } else if (isPaperUrl(result.url)) {
      paperDigest = await digestPaper(result.url, { context, task, flags }).catch(
        () => null
      );
      if (paperDigest) {
        sourceText = formatPaperDigestAsText(paperDigest);
        fetchStatus = `paper_digest_${paperDigest.digest_scope || "unknown"}`;
      }
    }
    if (!sourceText) {
      const opened = await openUrl(result.url, flags).catch(() => "");
      sourceText = opened || result.snippet || "";
      fetchStatus = opened ? "http_fetch_ok" : "search_snippet_only";
    }
    const excerpt = extractExcerpt(sourceText, keywords);
    if (!excerpt || excerpt.length < 120) continue;
    const sourceSnapshot = await persistSourceSnapshot({
      outDir,
      url: result.url,
      title: result.title || result.url,
      sourceType: source_type,
      fetchStatus,
      sourceText
    });

    const partial = {
      task_id: task.id,
      title: result.title || result.url,
      url: result.url,
      provider: result.provider,
      query,
      excerpt,
      source_type,
      source_quality: sourceQuality(source_type),
      relevance: task.objective,
      ...sourceSnapshot
    };
    const claims = await extractClaims({ context, task, source: partial });
    const scored = scoreEvidence({ sourceType: source_type, excerpt, context, task, claims });

    evidence.push({
      ...partial,
      round,
      claims,
      keyword_hits: scored.keyword_hits,
      score: scored.score,
      repo_digest: repoDigest,
      paper_digest: paperDigest
    });

    if (evidence.length >= maxSources) return;
  }
}

async function runResearchAgent({ task, context, flags, outDir }) {
  const maxSources = Number(flags["max-sources"] || 5);
  const maxRounds = Math.max(1, Number(flags["max-rounds"] || 2));
  const seedQueries = toArray(task.search_queries).slice(0, 5);
  const keywords = evidenceKeywords(context, task);
  const seenUrls = new Set();
  const triedQueries = new Set();
  const evidence = [];

  await appendEvent(outDir, "research_agent_started", {
    task_id: task.id,
    title: task.title,
    max_rounds: maxRounds,
    max_sources: maxSources
  });

  let pendingQueries = [...seedQueries];
  let round = 0;
  let completionReason = "max_rounds_reached";

  while (
    round < maxRounds &&
    evidence.length < maxSources &&
    pendingQueries.length > 0
  ) {
    round += 1;
    const roundQueries = pendingQueries.filter((query) => !triedQueries.has(query));
    if (roundQueries.length === 0) {
      completionReason = "no_new_queries";
      break;
    }
    await appendEvent(outDir, "research_round_started", {
      task_id: task.id,
      round,
      queries: roundQueries
    });

    for (const query of roundQueries) {
      triedQueries.add(query);
      await gatherEvidenceForQuery({
        query,
        task,
        context,
        flags,
        keywords,
        seenUrls,
        evidence,
        round,
        maxSources,
        outDir
      });
      if (evidence.length >= maxSources) break;
    }

    await appendEvent(outDir, "research_round_completed", {
      task_id: task.id,
      round,
      evidence_count: evidence.length
    });

    if (evidence.length >= maxSources) {
      completionReason = "max_sources_reached";
      break;
    }
    if (round >= maxRounds) {
      completionReason = "max_rounds_reached";
      break;
    }

    const judgment = await judgeResearchProgress({
      task,
      evidence,
      alreadyQueried: [...triedQueries]
    });
    await appendEvent(outDir, "research_round_judged", {
      task_id: task.id,
      round,
      complete: judgment.complete,
      reason: judgment.reason,
      next_queries: judgment.next_queries
    });

    if (judgment.complete) {
      completionReason = "judge_complete";
      break;
    }
    pendingQueries = judgment.next_queries.filter(
      (query) => !triedQueries.has(query)
    );
    if (pendingQueries.length === 0) {
      completionReason = "no_new_queries";
      break;
    }
  }

  const report = `## ${task.id}: ${task.title}

Objective: ${task.objective}

Rounds: ${round}. Completion: ${completionReason}.

Findings:
${
    evidence
      .map((item, index) => {
        const claim = item.claims[0]?.claim || item.excerpt.slice(0, 260);
        return `- [${index + 1}] ${item.title} (${item.source_type}, round ${item.round}, score ${item.score}): ${claim}`;
      })
      .join("\n") || "- No evidence collected."
  }
`;

  await appendEvent(outDir, "research_agent_finished", {
    task_id: task.id,
    rounds: round,
    evidence_count: evidence.length,
    completion_reason: completionReason
  });

  return { task, evidence, report, rounds: round, completionReason };
}

async function runResearchAgents({ plan, context, flags, outDir }) {
  const results = [];
  const tasks = plan.tasks || [];

  for (let index = 0; index < tasks.length; index += MAX_PARALLEL_RESEARCH_AGENTS) {
    const batch = tasks.slice(index, index + MAX_PARALLEL_RESEARCH_AGENTS);
    await appendEvent(outDir, "research_batch_started", {
      task_ids: batch.map((task) => task.id)
    });
    const batchResults = await Promise.all(
      batch.map((task) => runResearchAgent({ task, context, flags, outDir }))
    );
    results.push(...batchResults);
  }

  return results;
}

function assignCitations(evidenceItems) {
  return evidenceItems
    .sort((a, b) => finiteNumber(b.score, 0) - finiteNumber(a.score, 0))
    .map((item, index) => ({
      citation_id: index + 1,
      ...item
    }));
}

function buildKnowledgeMap(evidenceItems) {
  const families = new Map();

  for (const item of evidenceItems) {
    for (const claim of item.claims || []) {
      const name = slugify(claim.architecture_family || "unspecified");
      if (!name || name === "unspecified") continue;
      const polarity = normalizePolarity(claim.polarity);
      const confidence = clampNumber(claim.confidence, { min: 0, max: 1, fallback: 0.5 });
      const evidenceScore = finiteNumber(item.score, 0);
      const existing =
        families.get(name) || {
          name,
          label: titleCase(claim.architecture_family),
          support: [],
          warnings: [],
          rejections: [],
          source_types: new Set(),
          citations: new Set(),
          score_total: 0
        };

      const record = {
        citation_id: item.citation_id,
        claim: claim.claim,
        risk_or_fit: claim.risk_or_fit,
        confidence,
        source_type: item.source_type,
        url: item.url
      };

      if (polarity === "supports") existing.support.push(record);
      else if (polarity === "rejects") existing.rejections.push(record);
      else existing.warnings.push(record);

      existing.source_types.add(item.source_type);
      existing.citations.add(item.citation_id);
      existing.score_total += evidenceScore * confidence;
      families.set(name, existing);
    }
  }

  const patterns = [...families.values()].map((item) => {
    const sourceTypes = [...item.source_types];
    const evidenceCount = item.support.length + item.warnings.length + item.rejections.length;
      const qualityGate =
        evidenceCount >= 2 &&
        item.support.length > 0 &&
        (sourceTypes.includes("official_docs") ||
          sourceTypes.includes("mature_oss") ||
          sourceTypes.includes("paper_or_benchmark") ||
          sourceTypes.includes("private_corpus"));

    return {
      name: item.name,
      label: item.label,
      promotion_status: qualityGate ? "evidence_backed_candidate" : "insufficient_evidence",
      evidence_count: evidenceCount,
      source_types: sourceTypes,
      citations: [...item.citations].sort((a, b) => a - b),
      support: item.support,
      warnings: item.warnings,
      rejections: item.rejections,
      score: Number(finiteNumber(item.score_total, 0).toFixed(3))
    };
  });

  const MAX_PROMOTED_CANDIDATES = 5;
  const allPromoted = patterns
    .filter((item) => item.promotion_status === "evidence_backed_candidate")
    .sort((a, b) => b.score - a.score);
  const promoted = allPromoted.slice(0, MAX_PROMOTED_CANDIDATES);
  const demoted = allPromoted.slice(MAX_PROMOTED_CANDIDATES).map((item) => ({
    ...item,
    promotion_status: "demoted_below_top_n",
    demotion_reason: `Below top-${MAX_PROMOTED_CANDIDATES} by evidence score; only the strongest macro families advance to synthesis.`
  }));

  return {
    version: VERSION,
    acquisition_mode: "evidence_only_live_research",
    promotion_rule:
      "Architecture families are promoted only from extracted claims with cited live-source evidence. Static seed hypotheses are not allowed. At most the top-5 evidence-scored macro families advance to synthesis.",
    promoted_candidates: promoted,
    insufficient_evidence_candidates: [
      ...patterns.filter((item) => item.promotion_status !== "evidence_backed_candidate"),
      ...demoted
    ]
  };
}

function deriveComparisonAxes(context) {
  const axes = [
    {
      id: "production_examples",
      label: "Production examples",
      rationale: "Mature OSS or engineering writeups documenting production deployments."
    },
    {
      id: "operational_complexity",
      label: "Operational complexity",
      rationale: "Ingestion, indexing, runtime, and maintenance overhead."
    },
    {
      id: "failure_modes",
      label: "Failure modes",
      rationale: "Known weaknesses surfaced by issues, postmortems, or limitations sections."
    }
  ];

  const shapeNames = toArray(context.query_shapes).map((shape) => shape.name);
  if (shapeNames.includes("multi_hop_relational")) {
    axes.push({
      id: "multi_hop_accuracy",
      label: "Multi-hop accuracy",
      rationale: "Domain has multi-hop relational queries."
    });
  }
  if (shapeNames.includes("audit_traceability")) {
    axes.push({
      id: "lineage_support",
      label: "Source lineage support",
      rationale: "Domain demands citation-grade lineage on every answer."
    });
  }
  if (shapeNames.includes("exploratory_research")) {
    axes.push({
      id: "exploration_support",
      label: "Exploration support",
      rationale: "Domain includes open-ended exploratory queries."
    });
  }
  if (shapeNames.includes("self_contained_lookup")) {
    axes.push({
      id: "self_contained_lookup_accuracy",
      label: "Self-contained lookup accuracy",
      rationale: "Domain includes self-contained docs/FAQ-style lookups."
    });
  }
  if (shapeNames.includes("transactional_state")) {
    axes.push({
      id: "transactional_integrity",
      label: "Transactional integrity",
      rationale: "Domain requires state-mutation safety."
    });
  }

  const envelope = context.operational_envelope || {};
  if (envelope.latency && envelope.latency !== "not_specified") {
    axes.push({
      id: "p95_latency",
      label: "p95 latency",
      rationale: `Envelope: ${envelope.latency}`
    });
  }
  if (envelope.cost && envelope.cost !== "not_specified") {
    axes.push({
      id: "cost_envelope",
      label: "Cost envelope",
      rationale: `Envelope: ${envelope.cost}`
    });
  }
  if (envelope.scale && envelope.scale !== "not_specified") {
    axes.push({
      id: "scale_envelope",
      label: "Scale envelope",
      rationale: `Envelope: ${envelope.scale}`
    });
  }
  if (envelope.availability && envelope.availability !== "not_specified") {
    axes.push({
      id: "availability",
      label: "Availability",
      rationale: `Envelope: ${envelope.availability}`
    });
  }
  if (toArray(context.compliance_constraints).length > 0) {
    axes.push({
      id: "audit_support",
      label: "Audit / compliance support",
      rationale: `Constraints: ${toArray(context.compliance_constraints).join(", ")}`
    });
  }

  return axes;
}

function candidatesFromKnowledgeMap(knowledgeMap) {
  const promoted = toArray(knowledgeMap?.promoted_candidates).map((item) => ({
    name: item.name,
    label: item.label,
    promotion_status: "evidence_backed_candidate",
    evidence_count: item.evidence_count,
    score: finiteNumber(item.score, 0),
    citations: item.citations
  }));
  const insufficient = toArray(knowledgeMap?.insufficient_evidence_candidates).map(
    (item) => ({
      name: item.name,
      label: item.label,
      promotion_status: "insufficient_evidence",
      evidence_count: item.evidence_count,
      score: finiteNumber(item.score, 0),
      citations: item.citations
    })
  );
  const seen = new Set();
  const merged = [];
  for (const candidate of [...promoted, ...insufficient]) {
    if (!candidate.name || seen.has(candidate.name)) continue;
    seen.add(candidate.name);
    merged.push(candidate);
  }
  return merged;
}

async function fillComparisonMatrixCells({
  context,
  axes,
  candidates,
  evidenceItems
}) {
  if (candidates.length === 0 || axes.length === 0) {
    return { cells: [], empty_cells: [] };
  }

  const result = await callLlmJson({
    label: "comparison_matrix_filler",
    system: [
      "You build a candidate × axis comparison matrix for an architecture decision.",
      "For each (candidate, axis) cell, return a verdict and a one-sentence summary.",
      "verdict is one of: 'strong' | 'mixed' | 'weak' | 'no_evidence'.",
      "Cite specific evidence_ids that justify the cell. If no evidence supports a verdict, return 'no_evidence' with empty evidence_citations.",
      "Be conservative: only mark 'strong' or 'weak' when claims are clearly supportive or rejecting; otherwise 'mixed' or 'no_evidence'.",
      "Do not invent evidence. Do not cite an evidence_id that does not appear in the supplied pool.",
      "Output JSON with {cells:[{candidate,axis,verdict,summary,evidence_citations:[number]}]}."
    ].join("\n"),
    user: JSON.stringify({
      domain: context.domain,
      decision: context.decision,
      axes,
      candidates: candidates.map((candidate) => ({
        name: candidate.name,
        label: candidate.label,
        promotion_status: candidate.promotion_status,
        evidence_count: candidate.evidence_count
      })),
      evidence: evidenceItems.map((item) => ({
        citation_id: item.citation_id,
        title: item.title,
        url: item.url,
        source_type: item.source_type,
        score: item.score,
        claims: item.claims
      }))
    })
  });

  const validCitationIds = new Set(evidenceItems.map((item) => Number(item.citation_id)));
  const cellMap = new Map();
  for (const raw of toArray(result.cells)) {
    const candidate = String(raw.candidate || "").trim();
    const axis = String(raw.axis || "").trim();
    if (!candidate || !axis) continue;
    let verdict = ["strong", "mixed", "weak", "no_evidence"].includes(String(raw.verdict))
      ? String(raw.verdict)
      : "no_evidence";
    const evidenceCitations = toArray(raw.evidence_citations)
      .map(Number)
      .filter((id) => Number.isFinite(id) && validCitationIds.has(id));
    if (evidenceCitations.length === 0) verdict = "no_evidence";
    cellMap.set(`${candidate}|${axis}`, {
      candidate,
      axis,
      verdict,
      summary: String(raw.summary || ""),
      evidence_citations: evidenceCitations
    });
  }

  const cells = [];
  const empty_cells = [];
  for (const candidate of candidates) {
    for (const axis of axes) {
      const key = `${candidate.name}|${axis.id}`;
      const cell = cellMap.get(key) || {
        candidate: candidate.name,
        axis: axis.id,
        verdict: "no_evidence",
        summary: "",
        evidence_citations: []
      };
      cells.push(cell);
      if (cell.verdict === "no_evidence" || cell.evidence_citations.length === 0) {
        empty_cells.push({
          candidate: candidate.name,
          axis: axis.id,
          axis_label: axis.label
        });
      }
    }
  }
  return { cells, empty_cells };
}

async function buildComparisonMatrix({
  context,
  knowledgeMap,
  evidenceItems
}) {
  const axes = deriveComparisonAxes(context);
  const candidates = candidatesFromKnowledgeMap(knowledgeMap);
  if (candidates.length === 0 || axes.length === 0) {
    return {
      version: VERSION,
      axes,
      candidates,
      cells: [],
      empty_cells: [],
      adversarial_queries_run: []
    };
  }
  const { cells, empty_cells } = await fillComparisonMatrixCells({
    context,
    axes,
    candidates,
    evidenceItems
  });

  return {
    version: VERSION,
    axes,
    candidates,
    cells,
    empty_cells,
    adversarial_queries_run: []
  };
}

async function buildAdversarialResearchPlan({
  context,
  matrix,
  evidenceItems
}) {
  if (matrix.empty_cells.length === 0 && matrix.candidates.length === 0) {
    return { tasks: [] };
  }

  const result = await callLlmJson({
    label: "adversarial_research_planner",
    system: [
      "You are the adversarial research planner for Architecture Deep Research.",
      "For each candidate architecture family, generate 1 task that hunts for the strongest case AGAINST the candidate:",
      "production failure stories, latency or scale incidents, lineage/audit limitations, ops complexity, ecosystem decline.",
      "If a comparison-matrix cell is empty (verdict 'no_evidence' or no citations), include one task that specifically targets that gap.",
      "Each task needs {id,title,objective,search_queries:[string],source_targets:[string],target_candidate,target_axis?}.",
      "Output JSON with {tasks:[...]}."
    ].join("\n"),
    user: JSON.stringify({
      domain: context.domain,
      decision: context.decision,
      candidates: matrix.candidates.map((candidate) => ({
        name: candidate.name,
        label: candidate.label,
        promotion_status: candidate.promotion_status
      })),
      axes: matrix.axes,
      empty_cells: matrix.empty_cells,
      existing_search_terms: [...new Set(evidenceItems.map((item) => item.query).filter(Boolean))].slice(
        0,
        25
      )
    })
  });

  return {
    version: VERSION,
    architecture: "adversarial_per_candidate",
    max_parallel_research_agents: MAX_PARALLEL_RESEARCH_AGENTS,
    tasks: toArray(result.tasks)
      .slice(0, 6)
      .map((task, index) => ({
        id: task.id || `X${index + 1}`,
        title: String(task.title || `Adversarial task ${index + 1}`),
        objective: String(task.objective || ""),
        search_queries: toArray(task.search_queries).map(String).slice(0, 4),
        source_targets: toArray(task.source_targets).map(String).slice(0, 5),
        success_criteria: toArray(task.success_criteria).map(String).slice(0, 5),
        target_candidate: String(task.target_candidate || "").trim() || null,
        target_axis: String(task.target_axis || "").trim() || null
      }))
      .filter((task) => task.search_queries.length > 0)
  };
}

async function synthesizeArchitectureSpec({
  context,
  knowledgeMap,
  evidenceItems,
  comparisonMatrix
}) {
  const promotedNames = toArray(knowledgeMap?.promoted_candidates).map((c) => c.name);
  const promotedSet = new Set(promotedNames);
  const HUMAN_REVIEW = "requires_human_architecture_review";

  const result = await callLlmJson({
    label: "architecture_synthesis_agent",
    system: [
      "You are the Architecture Deep Research synthesis agent.",
      "Choose an architecture family only from evidence-backed research claims.",
      "Use the comparison_matrix as the primary input: a candidate is only 'strong' on an axis when the matrix says so with cited evidence.",
      "If many cells are no_evidence or weak, prefer requires_human_architecture_review.",
      "Do not use a static pattern library.",
      "Do not implement the product.",
      "",
      `selected_topology MUST be one of the promoted_candidates names below, or the literal string "${HUMAN_REVIEW}". Do not invent a new name. Do not pick from insufficient_evidence_candidates.`,
      promotedNames.length > 0
        ? `Allowed selected_topology values: ${promotedNames.map((n) => `"${n}"`).join(", ")} or "${HUMAN_REVIEW}".`
        : `No candidate cleared the promotion gate. selected_topology MUST be "${HUMAN_REVIEW}".`,
      "",
      "Output JSON with {decision, domain_model, candidate_topologies, guardrails, evidence_summary}.",
      "decision needs {id,title,status,selected_topology,summary,evidence_citations}.",
      "candidate_topologies items need {name,label,fit,risks,decision,evidence_citations,confidence}.",
      "guardrails needs {forbidden_topologies,required_invariants,allowed_agentic_use,enforcement_notes}."
    ].join("\n"),
    user: JSON.stringify({
      context,
      knowledge_map: knowledgeMap,
      comparison_matrix: comparisonMatrix,
      evidence: evidenceItems.map((item) => ({
        citation_id: item.citation_id,
        title: item.title,
        url: item.url,
        source_type: item.source_type,
        score: item.score,
        claims: item.claims
      }))
    })
  });

  // Hard stop: synthesizer cannot promote a candidate that didn't clear the gate.
  // The LLM may still hallucinate a name; override it here.
  const requested = String(result.decision?.selected_topology || "").trim();
  const requestedSlug = slugify(requested);
  let selected;
  let overrideReason = null;
  if (promotedSet.size === 0) {
    selected = HUMAN_REVIEW;
    if (requested && requestedSlug !== HUMAN_REVIEW) {
      overrideReason = `Synthesizer returned "${requested}" but no candidate cleared the promotion gate.`;
    }
  } else if (requestedSlug === HUMAN_REVIEW) {
    selected = HUMAN_REVIEW;
  } else if (promotedSet.has(requestedSlug)) {
    selected = requestedSlug;
  } else {
    selected = HUMAN_REVIEW;
    overrideReason = `Synthesizer returned "${requested}" which is not in the promoted_candidates set [${[...promotedSet].join(", ")}]; forced to ${HUMAN_REVIEW}.`;
  }
  const validCitationIds = new Set(evidenceItems.map((item) => Number(item.citation_id)));
  const candidates = toArray(result.candidate_topologies).map((candidate) => {
    const candidateName = String(candidate.name || "").trim();
    const rawDecision = String(candidate.decision || "");
    const normalizedDecision = normalizeCandidateDecision(rawDecision, {
      candidateName,
      selectedTopology: selected
    });
    return {
      name: candidateName,
      label: String(candidate.label || candidate.name || ""),
      fit: String(candidate.fit || ""),
      risks: toArray(candidate.risks).map(String),
      decision: normalizedDecision,
      ...(rawDecision && rawDecision !== normalizedDecision ? { decision_rationale: rawDecision } : {}),
      evidence_citations: toArray(candidate.evidence_citations)
        .map(Number)
        .filter((id) => Number.isFinite(id) && validCitationIds.has(id)),
      confidence: clampNumber(candidate.confidence, { min: 0, max: 1, fallback: 0 })
    };
  });
  return {
    version: VERSION,
    decision: {
      id: result.decision?.id || "ADR-001",
      title: result.decision?.title || titleCase(context.decision),
      status: normalizeDecisionStatus(result.decision?.status),
      selected_topology: selected,
      summary: overrideReason
        ? `${HUMAN_REVIEW}: ${overrideReason}`
        : result.decision?.summary ||
          "Architecture decision synthesized from live evidence acquisition.",
      evidence_citations: toArray(result.decision?.evidence_citations)
        .map(Number)
        .filter((id) => Number.isFinite(id) && validCitationIds.has(id)),
      ...(overrideReason ? { override_reason: overrideReason } : {})
    },
    domain_model: {
      bounded_contexts: toArray(result.domain_model?.bounded_contexts).length
        ? toArray(result.domain_model.bounded_contexts)
        : context.bounded_contexts,
      core_entities: toArray(result.domain_model?.core_entities).length
        ? toArray(result.domain_model.core_entities)
        : context.domain_entities,
      domain_invariants: toArray(result.domain_model?.domain_invariants).length
        ? toArray(result.domain_model.domain_invariants)
        : context.risk_invariants
    },
    candidate_topologies: candidates,
    guardrails: {
      forbidden_topologies: toArray(result.guardrails?.forbidden_topologies),
      required_invariants: toArray(result.guardrails?.required_invariants).length
        ? toArray(result.guardrails.required_invariants)
        : context.risk_invariants,
      allowed_agentic_use: toArray(result.guardrails?.allowed_agentic_use).length
        ? toArray(result.guardrails.allowed_agentic_use)
        : ["source discovery", "evidence acquisition", "human-reviewed architecture comparison"],
      enforcement_notes: toArray(result.guardrails?.enforcement_notes)
    },
    evidence_summary: result.evidence_summary || {},
    evidence: evidenceItems.slice(0, 16).map((item) => ({
      label: `[${item.citation_id}] ${item.title}`,
      url: item.url,
      relevance: item.relevance,
      source_type: item.source_type,
      score: item.score
    }))
  };
}

async function buildEvaluationPack(context, spec, evidenceItems) {
  const result = await callLlmJson({
    label: "evaluation_pack_agent",
    system: [
      "You generate adversarial domain evaluation packs for architecture validation.",
      "Use the selected architecture spec and domain context.",
      "Create tests that stress DDD boundaries, lineage, abstention, multi-hop behavior, SLA, and agentic drift.",
      "Do not implement the product.",
      "Output JSON with {suite,target_topologies,metrics,test_cases}."
    ].join("\n"),
    user: JSON.stringify({
      context,
      spec,
      evidence: evidenceItems.slice(0, 10).map((item) => ({
        citation_id: item.citation_id,
        title: item.title,
        claims: item.claims
      }))
    })
  });

  return {
    version: VERSION,
    suite: result.suite || slugify(context.domain || "architecture_deep_research_suite"),
    target_topologies: toArray(result.target_topologies).length
      ? toArray(result.target_topologies)
      : [spec.decision.selected_topology],
    metrics: normalizeEvaluationMetrics(result.metrics),
    test_cases: normalizeEvaluationCases(result.test_cases, context, spec).slice(0, 12)
  };
}

function normalizeEvaluationMetrics(metrics) {
  const defaults = {
    deterministic_lineage_rate: { target: 0.98 },
    boundary_spill_tolerance: { target: 0 },
    unsupported_answer_rate: { target: 0 },
    p95_latency_ms: { target: 2500 }
  };
  const merged = { ...defaults, ...(metrics || {}) };
  for (const [key, value] of Object.entries(merged)) {
    if (!value || typeof value !== "object") {
      merged[key] = { target: finiteNumber(value, defaults[key]?.target || 0) };
      continue;
    }
    const defaultTarget = defaults[key]?.target || 0;
    const target = finiteNumber(value.target, defaultTarget);
    merged[key] = { ...value, target };
  }
  for (const key of [
    "deterministic_lineage_rate",
    "boundary_spill_tolerance",
    "unsupported_answer_rate"
  ]) {
    merged[key].target = clampNumber(merged[key].target, { min: 0, max: 1, fallback: defaults[key].target });
  }
  return merged;
}

function normalizeEvaluationCases(testCases, context, spec) {
  const entities = context.domain_entities.length
    ? context.domain_entities
    : ["DomainEntity", "SourceDocument"];
  const normalized = toArray(testCases)
    .map((testCase, index) => ({
      id: testCase.id || `TC-${String(index + 1).padStart(3, "0")}`,
      type: testCase.type || "architecture_invariant",
      question:
        testCase.question ||
        `Validate that ${spec.decision.selected_topology} preserves the required architecture invariants.`,
      expected_entities: toArray(testCase.expected_entities).length
        ? toArray(testCase.expected_entities)
        : entities.slice(0, 5),
      minimum_citation_depth: Number.isInteger(testCase.minimum_citation_depth)
        ? testCase.minimum_citation_depth
        : 1,
      abstention_rule:
        testCase.abstention_rule ||
        "Abstain when the answer cannot be supported by cited source evidence.",
      acceptance_criteria: toArray(testCase.acceptance_criteria).length
        ? toArray(testCase.acceptance_criteria)
        : [
            "Answer preserves the selected architecture invariants.",
            "Answer includes source citations for material claims.",
            "Answer does not cross bounded-context boundaries without an explicit interface."
          ]
    }))
    .filter((testCase) => testCase.question);

  if (normalized.length > 0) return normalized;

  return [
    {
      id: "TC-001",
      type: "architecture_invariant",
      question: `Validate that ${spec.decision.selected_topology} can answer a representative ${context.domain} query without violating source lineage.`,
      expected_entities: entities.slice(0, 5),
      minimum_citation_depth: 1,
      abstention_rule:
        "Abstain when the answer cannot be supported by cited source evidence.",
      acceptance_criteria: [
        "Answer includes source citations for material claims.",
        "Answer preserves bounded-context ownership.",
        "Answer does not replace the selected topology with an easier implementation path."
      ]
    }
  ];
}

function buildGuardrails(spec) {
  return `# Agent Guardrails: ${spec.decision.title}

Selected topology: \`${spec.decision.selected_topology}\`

## ADR Boundary

ADR has ended at Execution Handoff. Your job is to consume these constraints, not to reinterpret the architecture decision.

## Required Invariants

${spec.guardrails.required_invariants.map((item) => `- ${item}`).join("\n")}

## Forbidden Topologies

${spec.guardrails.forbidden_topologies.map((item) => `- ${item}`).join("\n") || "- None specified."}

## Agentic Use

Agentic behavior is allowed only for:

${spec.guardrails.allowed_agentic_use.map((item) => `- ${item}`).join("\n")}

Do not replace the selected topology with an easier local implementation path without producing a superseding ADR.
`;
}

function buildADR(context, spec, knowledgeMap) {
  const selected = spec.decision.selected_topology;
  const rejected = spec.candidate_topologies.filter(
    (candidate) => candidate.decision === "rejected"
  );

  return `# ${spec.decision.id}: ${spec.decision.title}

Status: ${titleCase(spec.decision.status)}

## Context

Domain: ${context.domain}

Decision focus: ${context.decision}

The Strategic Context Model identified these query shapes:

${context.query_shapes.map((shape) => `- ${shape.name}: ${shape.evidence.join(", ")}`).join("\n")}

The core entities extracted from the brief are:

${context.domain_entities.map((entity) => `- ${entity}`).join("\n") || "- No explicit entities found."}

## Decision

Use **${titleCase(selected)}**.

${spec.decision.summary}

Evidence citations: ${toArray(spec.decision.evidence_citations).map((id) => `[${id}]`).join(", ") || "none"}

## Evidence Acquisition

Promotion rule: ${knowledgeMap.promotion_rule}

Promoted candidates:
${knowledgeMap.promoted_candidates.map((item) => `- ${item.label}: citations ${item.citations.map((id) => `[${id}]`).join(", ")}`).join("\n") || "- No candidate passed promotion gates."}

## Rationale

${spec.guardrails.required_invariants.map((item) => `- ${item}`).join("\n")}

## Rejected Alternatives

${rejected
  .map(
    (candidate) =>
      `### ${candidate.label || titleCase(candidate.name)}\n\n${candidate.fit}\n\nRisks:\n${candidate.risks.map((risk) => `- ${risk}`).join("\n")}\n\nEvidence: ${candidate.evidence_citations.map((id) => `[${id}]`).join(", ") || "none"}`
  )
  .join("\n\n") || "No rejected alternatives were synthesized."}

## Bounded Contexts

${spec.domain_model.bounded_contexts.map((item) => `- ${item}`).join("\n") || "- To be reviewed by the Architect agent."}

## Execution Handoff

ADR stops here. Downstream coding agents consume the architecture spec, guardrails, and evaluation pack. Implementation results may feed back as validation evidence, drift evidence, or grounds for a superseding ADR.
`;
}

function buildExecutionHandoff(spec) {
  return {
    version: VERSION,
    decision_id: spec.decision.id,
    handoff_boundary: "adr_stops_at_execution_handoff",
    artifacts: {
      adr: "ADR.md",
      architecture_spec: "architecture.spec.json",
      domain_evaluation_pack: "domain-evaluation-pack.json",
      agent_guardrails: "agent-guardrails.md",
      sources: "sources.md",
      strategic_context: "strategic-context.json",
      research_plan: "research-plan.json",
      research_report: "research-report.md",
      evidence: "evidence.json",
      knowledge_map: "knowledge-map.json",
      event_log: "events.jsonl"
    },
    agent_targets: [
      "beevibe_agent_mesh",
      "claude_code_workspace_rules",
      "cursor_workspace_rules",
      "codex_workspace_rules"
    ],
    required_invariants: spec.guardrails.required_invariants,
    forbidden_topologies: spec.guardrails.forbidden_topologies,
    feedback_contract: {
      expected_inputs_from_execution: [
        "domain evaluation results",
        "architecture drift reports",
        "constraint violation reports",
        "operator review notes"
      ],
      may_trigger_superseding_adr: true
    }
  };
}

async function scanUncitedClaimsPhase({
  context,
  spec,
  evaluationPack,
  adrMarkdown,
  researchReport,
  evidenceItems,
  outDir
}) {
  let raw;
  try {
    raw = await callLlmJson({
      label: "uncited_claim_scanner",
      system: [
        "You audit generated Architecture Deep Research artifacts for material architecture claims.",
        "Find claims in ADR.md, research-report.md, architecture.spec.json, and domain-evaluation-pack.json that need citations or stronger evidence.",
        "Do not flag headings, generic process text, or restatements of the user's product context.",
        "A claim is material when it recommends, rejects, compares, scores, or asserts a topology's capability, risk, latency, cost, reliability, compliance, or evidence quality.",
        "If a material claim is already supported by the cited evidence pool, include the citation_ids.",
        "If it is not supported or has no clear citation, set needs_citation:true.",
        "Output JSON with {claims:[{artifact,claim_text,citation_ids:[number],needs_citation:boolean,severity:'high'|'medium'|'low',reason:string}],summary:string}."
      ].join("\n"),
      user: JSON.stringify({
        domain: context.domain,
        decision: context.decision,
        selected_topology: spec.decision?.selected_topology,
        artifacts: {
          adr_markdown: adrMarkdown.slice(0, 18_000),
          research_report: researchReport.slice(0, 18_000),
          architecture_spec: spec,
          domain_evaluation_pack: evaluationPack
        },
        evidence: evidenceItems.map((item) => ({
          citation_id: item.citation_id,
          title: item.title,
          url: item.url,
          source_type: item.source_type,
          claims: item.claims,
          excerpt: (item.excerpt || "").slice(0, 800)
        }))
      })
    });
  } catch (error) {
    raw = {
      claims: [
        {
          artifact: "claim_audit",
          claim_text: `Claim audit LLM call failed: ${String(error?.message || error)}. No claims could be audited; manual review required.`,
          citation_ids: [],
          needs_citation: true,
          severity: "high",
          reason: "tooling_failure"
        }
      ],
      summary: `claim_audit_failed: ${String(error?.message || error)}`
    };
  }

  const validCitationIds = new Set(evidenceItems.map((item) => Number(item.citation_id)));
  const claims = toArray(raw.claims)
    .filter((claim) => claim && typeof claim === "object" && !Array.isArray(claim))
    .map((claim) => ({
      artifact: String(claim.artifact || "unknown"),
      claim_text: String(claim.claim_text || ""),
      citation_ids: toArray(claim.citation_ids)
        .map(Number)
        .filter((id) => Number.isFinite(id) && validCitationIds.has(id)),
      needs_citation: Boolean(claim.needs_citation),
      severity: ["high", "medium", "low"].includes(String(claim.severity))
        ? String(claim.severity)
        : "low",
      reason: String(claim.reason || "")
    }))
    .filter((claim) => claim.claim_text);

  const highSeverityCount = claims.filter(
    (claim) => claim.needs_citation && claim.severity === "high"
  ).length;
  const audit = {
    version: VERSION,
    selected_topology: spec.decision?.selected_topology,
    total_claims_checked: claims.length,
    uncited_material_claim_count: claims.filter((claim) => claim.needs_citation).length,
    high_severity_count: highSeverityCount,
    claims,
    summary: String(raw.summary || "")
  };
  await writeJson(path.join(outDir, "claim-audit.json"), audit);
  await appendEvent(outDir, "claim_audit_completed", {
    total_claims_checked: audit.total_claims_checked,
    uncited_material_claim_count: audit.uncited_material_claim_count,
    high_severity_count: audit.high_severity_count
  });
  return audit;
}

function buildDeepSources(context, evidenceItems) {
  const cited = evidenceItems
    .map(
      (item) =>
        `- [${item.citation_id}] ${item.title} (${item.url}) - ${item.source_type}; score ${item.score}; retrieved ${item.retrieved_at || "unknown"}; hash ${item.content_hash || "unknown"}${item.raw_text_path ? `; snapshot ${item.raw_text_path}` : ""}`
    )
    .join("\n");

  return `# Sources

## Local Source

- ${context.source.path}
- SHA-256: ${context.source.content_hash}

## Evidence Used

${cited || "- No external evidence was collected."}

## Notes

Sources are preserved as evidence items before synthesis. Downstream adapters should prefer preserving raw source excerpts over early summarization so contradictions and weak evidence can still be audited.
`;
}

function synthesizeResearchReport({ context, plan, spec, evidenceItems, researchResults, knowledgeMap }) {
  const topEvidence = evidenceItems.slice(0, 10);

  return `# Architecture Deep Research Report

## Decision

ADR recommends **${titleCase(spec.decision.selected_topology)}** for **${context.domain}**.

## Research Mode

- Live search providers only.
- LLM-driven planning, claim extraction, synthesis, and adversarial evaluation generation.
- No offline mode.
- No static pattern oracle.

## Research Coverage

${(plan.tasks || []).map((task) => `- ${task.id}: ${task.title}`).join("\n")}

## Knowledge Acquisition

Promoted candidates:
${knowledgeMap.promoted_candidates.map((item) => `- ${item.label}: ${item.evidence_count} claims, citations ${item.citations.map((id) => `[${id}]`).join(", ")}`).join("\n") || "- None."}

Insufficient evidence candidates:
${knowledgeMap.insufficient_evidence_candidates.map((item) => `- ${item.label}: ${item.evidence_count} claims`).join("\n") || "- None."}

## Evidence Summary

${topEvidence
  .map((item) => `- [${item.citation_id}] ${item.title}: ${item.claims[0]?.claim || item.excerpt.slice(0, 320)}`)
  .join("\n") || "- No external evidence was collected."}

## Intermediate Reports

${researchResults.map((result) => result.report).join("\n")}

## Boundary

ADR stops at Execution Handoff. The report supports architecture selection; it does not authorize the research agent to implement the product.
`;
}

async function writeJson(filePath, value) {
  await assertSchemaValid(path.basename(filePath), value);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function research({ inputPath, flags }) {
  return deepResearch({ inputPath, flags });
}

async function prepareRun({ inputPath, flags }) {
  if (!inputPath || !flags.domain || !flags.decision || !flags.out) {
    throw new Error("Usage: adr deep-research <product-context.md> --domain <domain> --decision <decision> --out <dir>");
  }

  const runtime = assertAgenticRuntime(flags);
  const outDir = path.resolve(flags.out);
  const content = await readFile(path.resolve(inputPath), "utf8");

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "events.jsonl"), "");
  resetLlmCost();
  await appendEvent(outDir, "run_started", {
    command: "deep-research",
    runtime,
    input_path: inputPath,
    domain: flags.domain,
    decision: flags.decision
  });

  const context = buildStrategicContext({
    sourcePath: inputPath,
    content,
    domain: flags.domain,
    decision: flags.decision
  });
  const clarification = assessClarification(context, content);
  await writeJson(path.join(outDir, "strategic-context.json"), context);
  await writeJson(path.join(outDir, "clarification.json"), clarification);
  await appendEvent(outDir, "strategic_context_created", {
    query_shapes: context.query_shapes.map((shape) => shape.name),
    bounded_contexts: context.bounded_contexts,
    needs_clarification: clarification.needs_clarification
  });

  const needsClarification =
    clarification.needs_clarification && Boolean(flags["strict-clarification"]);

  if (needsClarification) {
    await writeJson(path.join(outDir, "state.json"), {
      version: VERSION,
      status: "needs_clarification",
      completed_at: nowIso(),
      handoff_boundary: "adr_not_started_due_to_missing_context"
    });
    await appendEvent(outDir, "run_waiting_for_clarification", {
      questions: clarification.questions
    });
  }

  return {
    runtime,
    outDir,
    content,
    context,
    clarification,
    needsClarification
  };
}

async function planResearchPhase({ context, content, outDir, flags }) {
  const plan = await buildResearchPlan(context, content);
  const maxCycles = Number(flags["max-cycles"] || 2);
  const boundedPlan = {
    ...plan,
    max_cycles: maxCycles,
    tasks: (plan.tasks || []).slice(0, Math.max(1, maxCycles) * MAX_PARALLEL_RESEARCH_AGENTS)
  };
  await writeJson(path.join(outDir, "research-plan.json"), boundedPlan);
  await appendEvent(outDir, "research_plan_created", {
    task_count: boundedPlan.tasks.length,
    max_cycles: maxCycles
  });
  return boundedPlan;
}

async function buildAdaptiveResearchPlan({ context, knowledgeMap, evidenceItems }) {
  const result = await callLlmJson({
    label: "adaptive_research_planner",
    system: [
      "You are the gap-filling research planner for Architecture Deep Research.",
      "Initial research did not produce evidence-backed architecture candidates.",
      "Read the Strategic Context Matrix, the insufficient_evidence_candidates list, and the existing evidence.",
      "Produce 2-4 new research tasks that target the specific gaps:",
      "- Find authoritative sources (official docs, mature OSS, papers/benchmarks) that promote or reject the insufficient candidates.",
      "- Find architecture families not yet considered that fit the domain shape.",
      "- Avoid repeating queries already tried unless you reframe them substantially.",
      "Each task needs {id,title,objective,search_queries:[string],source_targets:[string],success_criteria:[string]}.",
      "Output JSON with {tasks:[...]}."
    ].join("\n"),
    user: JSON.stringify({
      context,
      knowledge_map: knowledgeMap,
      existing_evidence: evidenceItems.map((item) => ({
        citation_id: item.citation_id,
        title: item.title,
        url: item.url,
        source_type: item.source_type,
        query: item.query
      }))
    })
  });

  return {
    version: VERSION,
    architecture: "adaptive_gap_filling",
    max_parallel_research_agents: MAX_PARALLEL_RESEARCH_AGENTS,
    tasks: toArray(result.tasks)
      .slice(0, 4)
      .map((task, index) => ({
        id: task.id || `A${index + 1}`,
        title: String(task.title || `Adaptive task ${index + 1}`),
        objective: String(task.objective || ""),
        search_queries: toArray(task.search_queries).map(String).slice(0, 4),
        source_targets: toArray(task.source_targets).map(String).slice(0, 5),
        success_criteria: toArray(task.success_criteria).map(String).slice(0, 5)
      }))
      .filter((task) => task.search_queries.length > 0)
  };
}

async function executeResearchPhase({ plan, context, outDir, flags }) {
  let researchResults = await runResearchAgents({ plan, context, flags, outDir });
  let evidenceItems = assignCitations(
    researchResults.flatMap((result) => result.evidence)
  );
  let knowledgeMap = buildKnowledgeMap(evidenceItems);

  const maxAdaptiveCycles = Math.max(
    0,
    Number(flags["max-adaptive-cycles"] || 1)
  );
  let adaptiveCycle = 0;

  while (
    knowledgeMap.promoted_candidates.length === 0 &&
    adaptiveCycle < maxAdaptiveCycles
  ) {
    adaptiveCycle += 1;
    await appendEvent(outDir, "adaptive_research_cycle_started", {
      cycle: adaptiveCycle,
      reason: "no_promoted_candidates",
      evidence_count: evidenceItems.length,
      insufficient_candidate_count: knowledgeMap.insufficient_evidence_candidates.length
    });

    let gapPlan;
    try {
      gapPlan = await buildAdaptiveResearchPlan({
        context,
        knowledgeMap,
        evidenceItems
      });
    } catch (error) {
      await appendEvent(outDir, "adaptive_research_cycle_skipped", {
        cycle: adaptiveCycle,
        reason: `planner_failed: ${String(error?.message || error)}`
      });
      break;
    }

    if (!gapPlan.tasks || gapPlan.tasks.length === 0) {
      await appendEvent(outDir, "adaptive_research_cycle_skipped", {
        cycle: adaptiveCycle,
        reason: "no_gap_tasks"
      });
      break;
    }

    await writeJson(
      path.join(outDir, `research-plan.adaptive-${adaptiveCycle}.json`),
      gapPlan
    );

    const moreResults = await runResearchAgents({
      plan: gapPlan,
      context,
      flags,
      outDir
    });
    researchResults = [...researchResults, ...moreResults];
    evidenceItems = assignCitations(
      researchResults.flatMap((result) => result.evidence)
    );
    knowledgeMap = buildKnowledgeMap(evidenceItems);

    await appendEvent(outDir, "adaptive_research_cycle_completed", {
      cycle: adaptiveCycle,
      evidence_count: evidenceItems.length,
      promoted_candidate_count: knowledgeMap.promoted_candidates.length
    });
  }

  await writeJson(path.join(outDir, "evidence.json"), evidenceItems);
  await writeJson(path.join(outDir, "knowledge-map.json"), knowledgeMap);
  await writeFile(
    path.join(outDir, "intermediate-reports.md"),
    researchResults.map((result) => result.report).join("\n")
  );
  await appendEvent(outDir, "evidence_collected", {
    evidence_count: evidenceItems.length,
    promoted_candidate_count: knowledgeMap.promoted_candidates.length,
    adaptive_cycles: adaptiveCycle
  });

  return { researchResults, evidenceItems, knowledgeMap, adaptiveCycle };
}

async function compareTopologiesPhase({
  context,
  knowledgeMap,
  evidenceItems,
  researchResults,
  outDir,
  flags
}) {
  const initialMatrix = await buildComparisonMatrix({
    context,
    knowledgeMap,
    evidenceItems
  });
  await writeJson(path.join(outDir, "comparison-matrix.json"), initialMatrix);
  await appendEvent(outDir, "comparison_matrix_built", {
    axes: initialMatrix.axes.length,
    candidates: initialMatrix.candidates.length,
    cells: initialMatrix.cells.length,
    empty_cells: initialMatrix.empty_cells.length
  });

  const maxAdversarialCycles = Math.max(
    0,
    Number(flags["max-adversarial-cycles"] || 1)
  );
  let matrix = initialMatrix;
  let updatedResearchResults = researchResults;
  let updatedEvidenceItems = evidenceItems;
  let updatedKnowledgeMap = knowledgeMap;
  let adversarialCycle = 0;

  while (
    adversarialCycle < maxAdversarialCycles &&
    (matrix.empty_cells.length > 0 || matrix.candidates.length > 0)
  ) {
    adversarialCycle += 1;
    let advPlan;
    try {
      advPlan = await buildAdversarialResearchPlan({
        context,
        matrix,
        evidenceItems: updatedEvidenceItems
      });
    } catch (error) {
      await appendEvent(outDir, "adversarial_research_cycle_skipped", {
        cycle: adversarialCycle,
        reason: `planner_failed: ${String(error?.message || error)}`
      });
      break;
    }
    if (!advPlan.tasks || advPlan.tasks.length === 0) {
      await appendEvent(outDir, "adversarial_research_cycle_skipped", {
        cycle: adversarialCycle,
        reason: "no_adversarial_tasks"
      });
      break;
    }
    await writeJson(
      path.join(outDir, `research-plan.adversarial-${adversarialCycle}.json`),
      advPlan
    );
    await appendEvent(outDir, "adversarial_research_cycle_started", {
      cycle: adversarialCycle,
      task_count: advPlan.tasks.length
    });

    const moreResults = await runResearchAgents({
      plan: advPlan,
      context,
      flags,
      outDir
    });
    updatedResearchResults = [...updatedResearchResults, ...moreResults];
    updatedEvidenceItems = assignCitations(
      updatedResearchResults.flatMap((result) => result.evidence)
    );
    updatedKnowledgeMap = buildKnowledgeMap(updatedEvidenceItems);

    await writeJson(path.join(outDir, "evidence.json"), updatedEvidenceItems);
    await writeJson(path.join(outDir, "knowledge-map.json"), updatedKnowledgeMap);
    await writeFile(
      path.join(outDir, "intermediate-reports.md"),
      updatedResearchResults.map((result) => result.report).join("\n")
    );

    matrix = await buildComparisonMatrix({
      context,
      knowledgeMap: updatedKnowledgeMap,
      evidenceItems: updatedEvidenceItems
    });
    matrix.adversarial_queries_run = advPlan.tasks.flatMap((task) => task.search_queries);
    await writeJson(path.join(outDir, "comparison-matrix.json"), matrix);
    await appendEvent(outDir, "adversarial_research_cycle_completed", {
      cycle: adversarialCycle,
      evidence_count: updatedEvidenceItems.length,
      empty_cells_after: matrix.empty_cells.length
    });
  }

  return {
    comparisonMatrix: matrix,
    researchResults: updatedResearchResults,
    evidenceItems: updatedEvidenceItems,
    knowledgeMap: updatedKnowledgeMap,
    adversarialCycles: adversarialCycle
  };
}

async function synthesizeDecisionPhase({
  context,
  knowledgeMap,
  evidenceItems,
  comparisonMatrix
}) {
  return synthesizeArchitectureSpec({
    context,
    knowledgeMap,
    evidenceItems,
    comparisonMatrix
  });
}

async function critiqueDecisionPhase({
  context,
  spec,
  knowledgeMap,
  evidenceItems,
  outDir
}) {
  let raw;
  try {
    raw = await callLlmJson({
      label: "architecture_critique_agent",
      system: [
        "You are the Architecture Deep Research critique agent.",
        "Critique the synthesized architecture spec against the evidence pool and knowledge map.",
        "Find: uncited claims; contradictions between cited claims; rejected alternatives missing rationale;",
        "evidence weaknesses (single source, low quality, no official_docs, mature_oss, paper_or_benchmark, or private_corpus backing);",
        "selected_topology not actually backed by promoted_candidates.",
        "Be specific and cite evidence by citation_id.",
        "Output JSON with {issues:[{severity:'high'|'medium'|'low',category:string,description:string,evidence_citations:[number]}],summary:string,recommend_human_review:boolean}."
      ].join("\n"),
      user: JSON.stringify({
        context,
        spec,
        knowledge_map: knowledgeMap,
        evidence: evidenceItems.map((item) => ({
          citation_id: item.citation_id,
          title: item.title,
          url: item.url,
          source_type: item.source_type,
          score: item.score,
          claims: item.claims
        }))
      })
    });
  } catch (error) {
    raw = {
      issues: [
        {
          severity: "high",
          category: "tooling_failure",
          description: `Critique LLM call failed: ${String(error?.message || error)}. Cannot verify spec; manual review required.`,
          evidence_citations: []
        }
      ],
      summary: `critique_failed: ${String(error?.message || error)}`,
      recommend_human_review: true
    };
  }

  const issues = toArray(raw.issues).map((issue) => ({
    severity: ["high", "medium", "low"].includes(String(issue.severity))
      ? String(issue.severity)
      : "low",
    category: String(issue.category || "unspecified"),
    description: String(issue.description || ""),
    evidence_citations: toArray(issue.evidence_citations)
      .map(Number)
      .filter((value) => Number.isFinite(value))
  }));

  const highSeverityCount = issues.filter((issue) => issue.severity === "high").length;
  const critique = {
    version: VERSION,
    selected_topology: spec.decision?.selected_topology,
    issues,
    summary: String(raw.summary || ""),
    high_severity_count: highSeverityCount,
    recommend_human_review: Boolean(raw.recommend_human_review)
  };

  await writeJson(path.join(outDir, "critique.json"), critique);
  await appendEvent(outDir, "critique_completed", {
    issue_count: issues.length,
    high_severity_count: highSeverityCount,
    recommend_human_review: critique.recommend_human_review
  });

  return critique;
}

async function verifyCitationsPhase({
  context,
  spec,
  evidenceItems,
  outDir
}) {
  const evidenceById = new Map(
    evidenceItems.map((item) => [Number(item.citation_id), item])
  );

  const citedPoints = [];
  for (const id of toArray(spec.decision?.evidence_citations).map(Number)) {
    if (Number.isFinite(id)) {
      citedPoints.push({
        citation_id: id,
        claim_context: "selected_topology_summary",
        claim_text: spec.decision?.summary || ""
      });
    }
  }
  for (const candidate of toArray(spec.candidate_topologies)) {
    for (const id of toArray(candidate.evidence_citations).map(Number)) {
      if (Number.isFinite(id)) {
        citedPoints.push({
          citation_id: id,
          claim_context: `candidate:${candidate.name}:${candidate.decision || "n/a"}`,
          claim_text: `${candidate.label || candidate.name} — fit: ${candidate.fit || ""}; risks: ${
            (candidate.risks || []).join("; ") || "n/a"
          }`
        });
      }
    }
  }

  const items = [];

  // Batch by claim_context so the verifier never sees the same citation_id twice
  // in one call — a single-batch call lets the model dedupe and silently drop
  // every duplicate context, which surfaces as `verifier_did_not_return_item`.
  const pointsByContext = new Map();
  for (const point of citedPoints) {
    const list = pointsByContext.get(point.claim_context) || [];
    list.push(point);
    pointsByContext.set(point.claim_context, list);
  }

  const verifyOneBatch = async (claimContext, batchPoints) => {
    try {
      const raw = await callLlmJson({
        label: "citation_verifier",
        system: [
          "You are the citation verifier for Architecture Deep Research.",
          "All cited_points in this call share the same claim_context.",
          "For each citation_id, decide whether the cited evidence's claims and excerpt actually support the shared claim_text.",
          "Be strict: a citation that only loosely touches the topic is NOT supporting.",
          "If the evidence is missing or empty, mark verified:false with reason 'no_evidence'.",
          "Return exactly one entry for every citation_id you receive — do not deduplicate, omit, or merge.",
          "Output JSON with {items:[{citation_id,verified:boolean,confidence:0..1,reason:string}]}."
        ].join("\n"),
        user: JSON.stringify({
          domain: context.domain,
          decision: context.decision,
          selected_topology: spec.decision?.selected_topology,
          claim_context: claimContext,
          claim_text: batchPoints[0]?.claim_text || "",
          cited_points: batchPoints.map((p) => ({ citation_id: p.citation_id })),
          evidence_lookup: batchPoints.map((point) => {
            const item = evidenceById.get(Number(point.citation_id));
            return {
              citation_id: point.citation_id,
              present: Boolean(item),
              title: item?.title,
              url: item?.url,
              source_type: item?.source_type,
              score: item?.score,
              claims: item?.claims || [],
              excerpt: (item?.excerpt || "").slice(0, 1200)
            };
          })
        })
      });
      return { claimContext, items: toArray(raw.items) };
    } catch (error) {
      return {
        claimContext,
        items: batchPoints.map((point) => ({
          citation_id: point.citation_id,
          verified: false,
          confidence: 0,
          reason: `verifier_failed: ${String(error?.message || error)}`
        }))
      };
    }
  };

  const batchResults = await Promise.all(
    Array.from(pointsByContext.entries()).map(([ctx, pts]) => verifyOneBatch(ctx, pts))
  );

  for (const { claimContext, items: batchItems } of batchResults) {
    for (const item of toArray(batchItems)) {
      const citationId = Number(item.citation_id);
      if (!Number.isFinite(citationId)) continue;
      items.push({
        citation_id: citationId,
        claim_context: claimContext,
        verified: Boolean(item.verified),
        confidence: clampNumber(item.confidence, { min: 0, max: 1, fallback: 0 }),
        reason: String(item.reason || ""),
        evidence_present: evidenceById.has(citationId)
      });
    }
  }

  // Synthesize: any cited_point not returned by the verifier is unverified.
  const returnedKey = (item) => `${item.citation_id}|${item.claim_context}`;
  const returnedKeys = new Set(items.map(returnedKey));
  for (const point of citedPoints) {
    const key = `${point.citation_id}|${point.claim_context}`;
    if (!returnedKeys.has(key)) {
      items.push({
        citation_id: point.citation_id,
        claim_context: point.claim_context,
        verified: false,
        confidence: 0,
        reason: "verifier_did_not_return_item",
        evidence_present: evidenceById.has(Number(point.citation_id))
      });
    }
  }

  const totalCitations = items.length;
  const verifiedCount = items.filter((item) => item.verified).length;
  const unsupportedCount = totalCitations - verifiedCount;
  const audit = {
    version: VERSION,
    selected_topology: spec.decision?.selected_topology,
    total_citations: totalCitations,
    verified_count: verifiedCount,
    unsupported_count: unsupportedCount,
    items
  };

  await writeJson(path.join(outDir, "citation-audit.json"), audit);
  await appendEvent(outDir, "citation_audit_completed", {
    total_citations: totalCitations,
    verified_count: verifiedCount,
    unsupported_count: unsupportedCount
  });
  return audit;
}

function applyCritique({ spec, critique, flags }) {
  if (!critique) return { spec, downgraded: false };
  if (flags["no-enforce-critique"]) return { spec, downgraded: false };
  if (
    critique.high_severity_count === 0 ||
    !critique.recommend_human_review ||
    spec.decision?.selected_topology === "requires_human_architecture_review"
  ) {
    return { spec, downgraded: false };
  }

  const downgradedSpec = {
    ...spec,
    decision: {
      ...spec.decision,
      original_selected_topology: spec.decision.selected_topology,
      selected_topology: "requires_human_architecture_review",
      summary: [
        spec.decision.summary || "",
        `Downgraded by critique (${critique.high_severity_count} high-severity issues): ${critique.summary}`
      ]
        .filter(Boolean)
        .join(" ")
    }
  };
  return { spec: downgradedSpec, downgraded: true };
}

function applyCitationAudit({ spec, citationAudit, flags }) {
  if (!citationAudit) return { spec, downgraded: false };
  if (flags["no-enforce-citation-audit"]) return { spec, downgraded: false };
  if (spec.decision?.selected_topology === "requires_human_architecture_review") {
    return { spec, downgraded: false };
  }

  const selected = slugify(spec.decision?.selected_topology);
  const unsupportedSelected = toArray(citationAudit.items).filter((item) => {
    if (item.verified) return false;
    const context = String(item.claim_context || "");
    return (
      context === "selected_topology_summary" ||
      context.startsWith(`candidate:${selected}:`)
    );
  });
  if (unsupportedSelected.length === 0) return { spec, downgraded: false };

  const downgradedSpec = {
    ...spec,
    decision: {
      ...spec.decision,
      original_selected_topology:
        spec.decision.original_selected_topology || spec.decision.selected_topology,
      selected_topology: "requires_human_architecture_review",
      summary: [
        spec.decision.summary || "",
        `Downgraded by citation audit (${unsupportedSelected.length} unsupported selected-topology citations).`
      ]
        .filter(Boolean)
        .join(" ")
    }
  };
  return { spec: downgradedSpec, downgraded: true, unsupportedSelected };
}

async function writeRunArtifacts({
  context,
  plan,
  spec,
  evidenceItems,
  researchResults,
  knowledgeMap,
  outDir,
  critique,
  citationAudit,
  comparisonMatrix,
  flags = {}
}) {
  const evaluationPack = await buildEvaluationPack(context, spec, evidenceItems);
  const baseHandoff = buildExecutionHandoff(spec);
  let handoff = baseHandoff;
  if (comparisonMatrix) {
    handoff = {
      ...handoff,
      artifacts: {
        ...handoff.artifacts,
        comparison_matrix: "comparison-matrix.json"
      },
      comparison_matrix_summary: {
        candidates: comparisonMatrix.candidates.length,
        axes: comparisonMatrix.axes.length,
        cells: comparisonMatrix.cells.length,
        empty_cells: comparisonMatrix.empty_cells.length,
        strong_cells: comparisonMatrix.cells.filter((cell) => cell.verdict === "strong").length,
        weak_cells: comparisonMatrix.cells.filter((cell) => cell.verdict === "weak").length
      }
    };
  }
  if (critique) {
    handoff = {
      ...handoff,
      artifacts: { ...handoff.artifacts, critique: "critique.json" },
      critique_summary: {
        issue_count: critique.issues.length,
        high_severity_count: critique.high_severity_count,
        recommend_human_review: critique.recommend_human_review
      }
    };
  }
  if (citationAudit) {
    handoff = {
      ...handoff,
      artifacts: { ...handoff.artifacts, citation_audit: "citation-audit.json" },
      citation_audit_summary: {
        total_citations: citationAudit.total_citations,
        verified_count: citationAudit.verified_count,
        unsupported_count: citationAudit.unsupported_count
      }
    };
  }
  const report = synthesizeResearchReport({
    context,
    plan,
    spec,
    evidenceItems,
    researchResults,
    knowledgeMap
  });
  const adrMarkdown = buildADR(context, spec, knowledgeMap);
  const claimAudit = flags["skip-claim-audit"]
    ? null
    : await scanUncitedClaimsPhase({
        context,
        spec,
        evaluationPack,
        adrMarkdown,
        researchReport: report,
        evidenceItems,
        outDir
      });
  if (claimAudit) {
    handoff = {
      ...handoff,
      artifacts: { ...handoff.artifacts, claim_audit: "claim-audit.json" },
      claim_audit_summary: {
        total_claims_checked: claimAudit.total_claims_checked,
        uncited_material_claim_count: claimAudit.uncited_material_claim_count,
        high_severity_count: claimAudit.high_severity_count
      }
    };
  }

  await writeFile(path.join(outDir, "ADR.md"), adrMarkdown);
  await writeJson(path.join(outDir, "architecture.spec.json"), spec);
  await writeJson(path.join(outDir, "domain-evaluation-pack.json"), evaluationPack);
  await writeFile(path.join(outDir, "agent-guardrails.md"), buildGuardrails(spec));
  await writeJson(path.join(outDir, "execution-handoff.json"), handoff);
  await writeFile(path.join(outDir, "research-report.md"), report);
  await writeFile(path.join(outDir, "sources.md"), buildDeepSources(context, evidenceItems));
  const costSummary = summarizeLlmCost();
  await writeJson(path.join(outDir, "cost.json"), costSummary);
  await writeJson(path.join(outDir, "state.json"), {
    version: VERSION,
    status: "completed",
    completed_at: nowIso(),
    selected_topology: spec.decision.selected_topology,
    original_selected_topology: spec.decision.original_selected_topology || null,
    evidence_count: evidenceItems.length,
    promoted_candidate_count: knowledgeMap.promoted_candidates.length,
    critique_high_severity_count: critique ? critique.high_severity_count : 0,
    citation_audit_unsupported_count: citationAudit ? citationAudit.unsupported_count : 0,
    claim_audit_high_severity_count: claimAudit ? claimAudit.high_severity_count : 0,
    claim_audit_uncited_material_claim_count: claimAudit
      ? claimAudit.uncited_material_claim_count
      : 0,
    comparison_matrix_empty_cells: comparisonMatrix ? comparisonMatrix.empty_cells.length : 0,
    estimated_usd: costSummary.totals.estimated_usd,
    handoff_boundary: "adr_stops_at_execution_handoff"
  });
  await appendEvent(outDir, "run_completed", {
    selected_topology: spec.decision.selected_topology,
    evidence_count: evidenceItems.length,
    critique_high_severity_count: critique ? critique.high_severity_count : 0,
    citation_audit_unsupported_count: citationAudit ? citationAudit.unsupported_count : 0,
    claim_audit_high_severity_count: claimAudit ? claimAudit.high_severity_count : 0,
    claim_audit_uncited_material_claim_count: claimAudit
      ? claimAudit.uncited_material_claim_count
      : 0,
    comparison_matrix_empty_cells: comparisonMatrix ? comparisonMatrix.empty_cells.length : 0,
    estimated_usd: costSummary.totals.estimated_usd,
    total_llm_calls: costSummary.totals.calls
  });

  return {
    selectedTopology: spec.decision.selected_topology,
    evidenceCount: evidenceItems.length,
    promotedCandidateCount: knowledgeMap.promoted_candidates.length,
    handoffBoundary: "adr_stops_at_execution_handoff",
    critiqueHighSeverityCount: critique ? critique.high_severity_count : 0,
    citationAuditUnsupportedCount: citationAudit ? citationAudit.unsupported_count : 0,
    claimAuditHighSeverityCount: claimAudit ? claimAudit.high_severity_count : 0,
    claimAuditUncitedMaterialClaimCount: claimAudit
      ? claimAudit.uncited_material_claim_count
      : 0,
    comparisonMatrixEmptyCells: comparisonMatrix ? comparisonMatrix.empty_cells.length : 0,
    estimatedUsd: costSummary.totals.estimated_usd,
    totalLlmCalls: costSummary.totals.calls
  };
}

async function deepResearch({ inputPath, flags }) {
  const prepared = await prepareRun({ inputPath, flags });
  if (prepared.needsClarification) {
    console.log(
      `Clarification needed. Questions written to ${path.join(prepared.outDir, "clarification.json")}`
    );
    return;
  }

  const plan = await planResearchPhase({
    context: prepared.context,
    content: prepared.content,
    outDir: prepared.outDir,
    flags
  });

  const executeResult = await executeResearchPhase({
    plan,
    context: prepared.context,
    outDir: prepared.outDir,
    flags
  });
  let researchResults = executeResult.researchResults;
  let evidenceItems = executeResult.evidenceItems;
  let knowledgeMap = executeResult.knowledgeMap;

  let comparisonMatrix = null;
  let adversarialCycles = 0;
  if (!flags["skip-comparison-matrix"]) {
    const compareResult = await compareTopologiesPhase({
      context: prepared.context,
      knowledgeMap,
      evidenceItems,
      researchResults,
      outDir: prepared.outDir,
      flags
    });
    comparisonMatrix = compareResult.comparisonMatrix;
    researchResults = compareResult.researchResults;
    evidenceItems = compareResult.evidenceItems;
    knowledgeMap = compareResult.knowledgeMap;
    adversarialCycles = compareResult.adversarialCycles;
  }

  const rawSpec = await synthesizeDecisionPhase({
    context: prepared.context,
    knowledgeMap,
    evidenceItems,
    comparisonMatrix
  });

  const critique = flags["skip-critique"]
    ? null
    : await critiqueDecisionPhase({
        context: prepared.context,
        spec: rawSpec,
        knowledgeMap,
        evidenceItems,
        outDir: prepared.outDir
      });

  const citationAudit = flags["skip-citation-audit"]
    ? null
    : await verifyCitationsPhase({
        context: prepared.context,
        spec: rawSpec,
        evidenceItems,
        outDir: prepared.outDir
      });

  const { spec: finalSpec, downgraded } = applyCritique({
    spec: rawSpec,
    critique,
    flags
  });
  const { spec: auditedSpec, downgraded: citationDowngraded, unsupportedSelected } =
    applyCitationAudit({
      spec: finalSpec,
      citationAudit,
      flags
    });
  if (downgraded) {
    await appendEvent(prepared.outDir, "decision_downgraded_by_critique", {
      original_selected_topology: finalSpec.decision.original_selected_topology,
      high_severity_count: critique.high_severity_count
    });
  }
  if (citationDowngraded) {
    await appendEvent(prepared.outDir, "decision_downgraded_by_citation_audit", {
      original_selected_topology: auditedSpec.decision.original_selected_topology,
      unsupported_selected_citation_count: unsupportedSelected.length
    });
  }

  const result = await writeRunArtifacts({
    context: prepared.context,
    plan,
    spec: auditedSpec,
    evidenceItems,
    researchResults,
    knowledgeMap,
    outDir: prepared.outDir,
    critique,
    citationAudit,
    comparisonMatrix,
    flags
  });

  console.log(`Deep research artifacts written to ${prepared.outDir}`);
  console.log(`Selected topology: ${result.selectedTopology}`);
  console.log(`Evidence items: ${result.evidenceCount}`);
  if (comparisonMatrix) {
    console.log(
      `Comparison matrix: ${comparisonMatrix.candidates.length} candidates × ${comparisonMatrix.axes.length} axes, ${comparisonMatrix.empty_cells.length} empty (adversarial cycles: ${adversarialCycles})`
    );
  }
  if (critique && critique.issues.length > 0) {
    console.log(
      `Critique: ${critique.issues.length} issues (${critique.high_severity_count} high-severity)`
    );
  }
  if (citationAudit && citationAudit.total_citations > 0) {
    console.log(
      `Citation audit: ${citationAudit.verified_count}/${citationAudit.total_citations} verified, ${citationAudit.unsupported_count} unsupported`
    );
  }
  if (result.totalLlmCalls > 0) {
    const usd = result.estimatedUsd != null ? `$${result.estimatedUsd.toFixed(4)}` : "n/a";
    console.log(`LLM cost: ${result.totalLlmCalls} calls, ~${usd} (see cost.json)`);
  }
  console.log("Boundary: ADR stops at Execution Handoff");
}

async function supersedeAdr({ previousDir, inputPath, flags }) {
  if (!previousDir) {
    throw new Error("Usage: adr supersede <previous-output-dir> --with <product-context.md> --domain <domain> --decision <decision> --out <dir>");
  }
  const previousSpecPath = path.join(path.resolve(previousDir), "architecture.spec.json");
  const previousSpec = JSON.parse(await readFile(previousSpecPath, "utf8"));
  const nextInputPath = flags.with || inputPath;
  if (!nextInputPath) {
    throw new Error("Superseding ADR requires --with <product-context.md>.");
  }

  await deepResearch({ inputPath: nextInputPath, flags });

  const outDir = path.resolve(flags.out);
  const nextSpec = JSON.parse(await readFile(path.join(outDir, "architecture.spec.json"), "utf8"));
  const supersedes = {
    version: VERSION,
    previous_decision_id: previousSpec.decision?.id,
    previous_topology: previousSpec.decision?.selected_topology,
    new_decision_id: nextSpec.decision?.id,
    new_topology: nextSpec.decision?.selected_topology,
    reason: flags.reason || "Superseding ADR generated from a new live Architecture Deep Research run.",
    previous_artifact_dir: previousDir,
    created_at: nowIso()
  };
  await writeJson(path.join(outDir, "supersedes.json"), supersedes);

  const adrPath = path.join(outDir, "ADR.md");
  const adr = await readFile(adrPath, "utf8");
  await writeFile(
    adrPath,
    `${adr}

## Supersedes

This ADR supersedes ${supersedes.previous_decision_id || "the previous ADR"} from \`${previousDir}\`.

- Previous topology: ${supersedes.previous_topology || "unknown"}
- New topology: ${supersedes.new_topology || "unknown"}
- Reason: ${supersedes.reason}
`
  );
}

export {
  VERSION,
  applyCitationAudit,
  activeLlmProvider,
  activeSearchProviders,
  applyCritique,
  assessClarification,
  buildAdaptiveResearchPlan,
  buildAdversarialResearchPlan,
  buildComparisonMatrix,
  buildEvaluationPack,
  buildExecutionHandoff,
  buildKnowledgeMap,
  buildResearchPlan,
  buildStrategicContext,
  classifySource,
  compareTopologiesPhase,
  critiqueDecisionPhase,
  deepResearch,
  deriveComparisonAxes,
  digestPaper,
  executeResearchPhase,
  getLlmJsonProvider,
  inspectGithubRepo,
  isGithubRepoUrl,
  isPaperUrl,
  planResearchPhase,
  prepareRun,
  research,
  resetLlmCost,
  runResearchAgents,
  setLlmJsonProvider,
  summarizeLlmCost,
  supersedeAdr,
  synthesizeDecisionPhase,
  verifyCitationsPhase,
  writeRunArtifacts
};
