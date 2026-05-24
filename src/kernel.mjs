import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const VERSION = "0.2.0";
const MAX_PARALLEL_RESEARCH_AGENTS = 3;
const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// Two ADR decision modes:
//   - "family":   choosing an architecture pattern / topology / approach
//                 (e.g. "retrieval topology", "event bus architecture")
//   - "concrete": choosing a specific product, vendor, library, service
//                 (e.g. "auth provider", "logging library", "queue service")
//
// The synthesizer's selected_topology means different things in each mode:
//   family mode   → an architecture family name ("graph_retrieval")
//   concrete mode → a specific product name        ("Clerk")
//
// Inferred from the decision name if not explicitly supplied via the
// --decision-kind CLI flag or decision_kind MCP arg.
function inferDecisionKind(decision) {
  const text = String(decision || "").toLowerCase();
  // concrete-mode keywords: the decision names a slot to be filled by a
  // specific product/vendor/library, not a pattern.
  const concreteKeywords = [
    "provider", "vendor", "service", "platform", "product", "solution",
    "library", "sdk", "framework", "tool", "package"
  ];
  for (const kw of concreteKeywords) {
    // word-boundary match so "service" doesn't match "microservice" (which
    // would be a family-mode hit).
    if (new RegExp(`\\b${kw}\\b`).test(text)) return "concrete";
  }
  return "family";
}

function normalizeDecisionKind(value, fallback) {
  const v = String(value || "").toLowerCase().trim();
  if (v === "family" || v === "concrete") return v;
  return fallback;
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

async function buildStrategicContext({ sourcePath, content, domain, decision, decisionKind }) {
  const resolvedKind = normalizeDecisionKind(decisionKind, inferDecisionKind(decision));
  const raw = await callLlmJson({
    label: "strategic_context_extractor",
    system: [
      "You are the strategic context extractor for Architecture Deep Research.",
      "Read the product context document and extract the architectural shape grounded in what the document actually says.",
      "Do not invent entities, contexts, or constraints that are not supported by the text.",
      "Leave a field empty (empty array, or the string \"not_specified\" for operational envelope fields) rather than inferring from prior knowledge of similar domains.",
      "",
      `This run's decision_kind is "${resolvedKind}".`,
      resolvedKind === "concrete"
        ? "Concrete mode: the user is picking a specific product / vendor / library / service (e.g. 'Clerk' for an auth provider, 'BullMQ' for a queue library). Downstream phases will compare named products. Your job here is only to extract the domain shape and constraints — do not enumerate vendors."
        : "Family mode: the user is picking an architecture family / topology / pattern (e.g. 'graph_retrieval' for a retrieval topology). Downstream phases will compare patterns.",
      "",
      "Output JSON with:",
      "- domain_entities: array of domain entity or aggregate names mentioned in or strongly implied by the text (PascalCase or as written).",
      "- bounded_contexts: array of bounded-context names (DDD-style) that the text describes or strongly implies. Each should be a noun phrase ending in \"Context\".",
      "- query_shapes: array of { name, evidence:[string] } describing kinds of queries or workflows the system must support. name is a slug-style identifier; evidence is brief quotes or paraphrases of the supporting text.",
      "- risk_invariants: array of architectural invariants the text requires (lineage, compliance, transactional safety, etc.). One sentence each.",
      "- operational_envelope: object with optional string fields latency, cost, scale, availability. Each should be a brief description of the constraint as stated, or the literal string \"not_specified\".",
      "- compliance_constraints: array of regulatory or audit constraints mentioned (e.g. \"HIPAA\", \"GDPR\", \"audit traceability\")."
    ].join("\n"),
    user: JSON.stringify({
      domain,
      decision,
      decision_kind: resolvedKind,
      product_context: content.slice(0, 24_000)
    })
  });

  const queryShapes = toArray(raw.query_shapes)
    .filter((shape) => shape && typeof shape === "object" && !Array.isArray(shape))
    .map((shape) => ({
      name: String(shape.name || "").trim(),
      evidence: toArray(shape.evidence).map(String).filter(Boolean)
    }))
    .filter((shape) => shape.name);

  const envelope = raw.operational_envelope && typeof raw.operational_envelope === "object"
    ? raw.operational_envelope
    : {};
  const envelopeField = (key) => {
    const value = envelope[key];
    return typeof value === "string" && value.trim() ? value.trim() : "not_specified";
  };

  return {
    version: VERSION,
    source: {
      path: sourcePath,
      content_hash: contentHash(content)
    },
    domain,
    decision,
    decision_kind: resolvedKind,
    domain_entities: toArray(raw.domain_entities).map(String).filter(Boolean),
    bounded_contexts: toArray(raw.bounded_contexts).map(String).filter(Boolean),
    query_shapes: queryShapes,
    risk_invariants: toArray(raw.risk_invariants).map(String).filter(Boolean),
    operational_envelope: {
      latency: envelopeField("latency"),
      cost: envelopeField("cost"),
      scale: envelopeField("scale"),
      availability: envelopeField("availability")
    },
    compliance_constraints: toArray(raw.compliance_constraints).map(String).filter(Boolean),
    acquisition_contract: {
      mode: "live_agentic_research_required",
      no_static_pattern_oracle: true,
      no_offline_research_mode: true,
      candidate_architecture_families_source:
        "Candidates must be acquired from live research evidence and synthesis, not from a hard-coded pattern library."
    }
  };
}

// Parse `## Open questions` bullets from a PRD-style markdown body. The
// discover stage explicitly writes this section as "things the scan could not
// infer and the user MUST fill in before running deep-research" — so we lift
// them straight into the clarification list rather than letting them sit
// dormant in the PRD nobody re-reads.
function parseOpenQuestions(content) {
  if (typeof content !== "string" || content.length === 0) return [];
  const lines = content.split(/\r?\n/);
  const headerRe = /^##\s+Open\s+questions\b/i;
  const nextHeaderRe = /^##\s+\S/;
  const bulletRe = /^\s*[-*+]\s+(.+\S)\s*$/;
  let inSection = false;
  const questions = [];
  for (const line of lines) {
    if (headerRe.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (nextHeaderRe.test(line)) break;
    const m = line.match(bulletRe);
    if (m && m[1]) questions.push(m[1].trim());
  }
  return questions;
}

function assessClarification(context, content) {
  const questions = [];

  if (content.length < 600) {
    questions.push("Could you provide more product context or a fuller PRD?");
  }
  if (context.domain_entities.length < 3) {
    questions.push("Which domain entities or aggregates must the architecture preserve?");
  }
  if (context.query_shapes.length === 0) {
    questions.push("What are representative user questions or workflows the system must support?");
  }
  if (context.compliance_constraints.length === 0 && /legal|medical|finance|enterprise/i.test(context.domain)) {
    questions.push("Are there audit, lineage, privacy, or compliance requirements?");
  }
  if (Object.values(context.operational_envelope).every((value) => value === "not_specified")) {
    questions.push("What latency, cost, scale, or availability constraints should shape the decision?");
  }

  for (const q of parseOpenQuestions(content)) {
    questions.push(`From PRD Open questions: ${q}`);
  }

  return {
    version: VERSION,
    needs_clarification: questions.length > 0,
    questions: questions.slice(0, 8),
    action:
      questions.length > 0
        ? "Re-run with --clarification-answers '<text>' (or edit the PRD), or pass --no-clarify to force a lower-confidence run."
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
  "constraints.json": "../docs/schemas/constraints.schema.json",
  "comparison-matrix.json": "../docs/schemas/comparison-matrix.schema.json",
  "critique.json": "../docs/schemas/critique.schema.json",
  "discovered-constraints.json": "../docs/schemas/discovered-constraints.schema.json",
  "discovered-principles.json": "../docs/schemas/discovered-principles.schema.json",
  "domain-evaluation-pack.json": "../docs/schemas/domain-evaluation-pack.schema.json",
  "evidence.json": "../docs/schemas/evidence.schema.json",
  "execution-handoff.json": "../docs/schemas/execution-handoff.schema.json",
  "knowledge-map.json": "../docs/schemas/knowledge-map.schema.json",
  "peers.json": "../docs/schemas/peers.schema.json",
  "research-plan.json": "../docs/schemas/research-plan.schema.json",
  "strategic-context.json": "../docs/schemas/strategic-context.schema.json",
  "supersedes.json": "../docs/schemas/supersedes.schema.json"
};

// Filenames intentionally written without schema validation. These are
// operational/index artifacts (run state, cost ledger) whose shape evolves
// with internal state rather than a stable contract. Add new content
// artifacts to schemaByFilename, not here.
const UNVALIDATED_ARTIFACTS = new Set(["state.json", "cost.json"]);

function resolveSchemaKey(filename) {
  if (schemaByFilename[filename]) return filename;
  if (/^research-plan\.(adaptive|adversarial)-\d+\.json$/.test(filename)) {
    return "research-plan.json";
  }
  // Re-synthesis loop writes architecture.spec.v1.json (the original) and
  // architecture.spec.v2.json (the post-critique re-synthesis). Both are
  // architecture.spec shapes. Same for critique.v1.json / critique.v2.json.
  if (/^architecture\.spec\.v\d+\.json$/.test(filename)) {
    return "architecture.spec.json";
  }
  if (/^critique\.v\d+\.json$/.test(filename)) {
    return "critique.json";
  }
  return null;
}

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
  if (UNVALIDATED_ARTIFACTS.has(filename)) return;
  const key = resolveSchemaKey(filename);
  if (!key) {
    throw new Error(
      `schema check requested for unregistered artifact: ${filename}. ` +
        `Register it in schemaByFilename or add it to UNVALIDATED_ARTIFACTS with intent.`
    );
  }
  const { validators } = await getSchemaValidators();
  const validator = validators.get(key);
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
  const kind = context.decision_kind || "family";
  const result = await callLlmJson({
    label: "research_plan_agent",
    system: [
      "You are the planning agent for Architecture Deep Research.",
      "Create source-acquisition tasks for a strategic architecture decision.",
      "Do not choose the architecture yet.",
      "Do not rely on a static pattern library.",
      "Prefer official docs, mature OSS, engineering writeups, benchmark papers, and postmortems.",
      "",
      `This run's decision_kind is "${kind}".`,
      kind === "concrete"
        ? "Concrete mode: candidates are SPECIFIC PRODUCTS / VENDORS / LIBRARIES, not architecture families. Generate tasks that (a) enumerate the 5-8 most credible product options for this decision, (b) investigate each named product's official docs, real-user case studies, pricing model, lock-in risk, and limitations. Search queries should include specific product names. source_targets should include vendor docs, product comparison pages, real engineering writeups about specific products, and postmortems naming specific products. Do NOT generate tasks about generic architecture patterns in this mode — the user already knows the pattern; they want the product."
        : "Family mode: candidates are ARCHITECTURE FAMILIES / TOPOLOGIES / PATTERNS. Generate tasks that survey patterns, compare topologies, and dig into engineering trade-offs at the family level.",
      "",
      "CRITICAL: every search_query MUST be a search string a human could paste",
      "into Google as-is and get useful results. Do NOT emit template placeholders",
      "like <product name>, <candidate>, or <vendor> in search_queries — fill them",
      "in with actual product or family names. A query containing literal angle-",
      "bracket placeholders will be dropped by the search executor and waste a",
      "task slot.",
      "",
      "Output JSON with: {tasks:[{id,title,objective,search_queries,source_targets,success_criteria}]}."
    ].join("\n"),
    user: JSON.stringify({
      domain: context.domain,
      decision: context.decision,
      decision_kind: kind,
      strategic_context: context,
      product_context_excerpt: content.slice(0, 16_000)
    })
  });

  if (!Array.isArray(result.tasks) || result.tasks.length === 0) {
    throw new Error("Research planning agent returned no tasks.");
  }

  // Defensive: drop search_queries that still contain literal angle-bracket
  // template placeholders. The prompt forbids them but LLMs sometimes emit
  // <product name> or <candidate> as plain text — those waste a task slot
  // by fetching unrelated marketing pages (we saw "Product Pricing: What Do
  // I Charge?" surface during a real run).
  const PLACEHOLDER_RE = /<[a-z][a-z0-9 _-]*>/i;
  return {
    version: VERSION,
    architecture: "live_agentic_deep_research",
    max_parallel_research_agents: MAX_PARALLEL_RESEARCH_AGENTS,
    tasks: result.tasks
      .slice(0, 8)
      .map((task, index) => {
        const filteredQueries = toArray(task.search_queries)
          .map(String)
          .filter((q) => q.trim().length > 0 && !PLACEHOLDER_RE.test(q));
        return {
          id: task.id || `R${index + 1}`,
          title: task.title || `Research task ${index + 1}`,
          objective: task.objective || "Acquire architecture evidence.",
          search_queries: filteredQueries.slice(0, 5),
          source_targets: toArray(task.source_targets).slice(0, 8),
          success_criteria: toArray(task.success_criteria).slice(0, 5)
        };
      })
      // Drop tasks whose every query was a placeholder — there is nothing
      // to search and the task slot is wasted.
      .filter((task) => task.search_queries.length > 0)
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

// Parse a comma- or whitespace-separated domain list from an env var into
// an array of bare domains (no protocol, no trailing slash). Empty input
// returns an empty array. Used by Tavily / Serper to bias the evidence
// pool toward engineering content and away from aggregators.
function parseDomainList(envValue) {
  if (!envValue || typeof envValue !== "string") return [];
  return envValue
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean)
    .slice(0, 16); // hard cap so we don't blow query length
}

function searchDomainFilters() {
  return {
    include: parseDomainList(process.env.ADR_SEARCH_INCLUDE_DOMAINS),
    exclude: parseDomainList(process.env.ADR_SEARCH_EXCLUDE_DOMAINS)
  };
}

// Apply `site:` / `-site:` operators inline for providers (Brave) that
// don't have native include/exclude fields. Caps to a handful so the
// query stays under URL limits.
function injectSiteOperators(query, { include, exclude }) {
  const parts = [query];
  for (const d of include.slice(0, 4)) parts.push(`site:${d}`);
  for (const d of exclude.slice(0, 6)) parts.push(`-site:${d}`);
  return parts.join(" ");
}

async function searchWithProvider(query) {
  if (shouldPreferMcpSearch()) {
    const mcpResults = await searchWithOpenAiMcp(query);
    if (mcpResults) return mcpResults;
  }

  const domainFilters = searchDomainFilters();

  if (process.env.BRAVE_SEARCH_API_KEY) {
    // Brave has no include/exclude_domains param. Inject site: operators
    // directly into the query when filters are configured.
    const effectiveQuery =
      domainFilters.include.length || domainFilters.exclude.length
        ? injectSiteOperators(query, domainFilters)
        : query;
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", effectiveQuery);
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
    // Serper does not document a native exclude_domains field; inline
    // site: operators are the supported path. Same for include.
    const effectiveQuery =
      domainFilters.include.length || domainFilters.exclude.length
        ? injectSiteOperators(query, domainFilters)
        : query;
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.SERPER_API_KEY
      },
      body: JSON.stringify({ q: effectiveQuery, num: 8 }),
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
    // Tavily supports include_domains / exclude_domains natively as arrays
    // in the request body. Use them when set, otherwise fall back to a
    // raw query.
    const body = {
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: 8,
      search_depth: "advanced"
    };
    if (domainFilters.include.length) body.include_domains = domainFilters.include;
    if (domainFilters.exclude.length) body.exclude_domains = domainFilters.exclude;
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000)
    });
    if (!response.ok) throw new Error(`Tavily search failed: ${response.status}`);
    const respBody = await response.json();
    return (respBody.results || []).map((item) => ({
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

// Cross-run page cache at ~/.adr/cache/. Iterative ADR runs (the actual user
// workflow — nobody nails the decision name on the first try) re-fetch the
// same pages on every run. The cache turns that into a no-op for pages
// younger than ADR_CACHE_TTL_DAYS (default 7).
//
// Keyed on the bare URL (fragment-stripped). Negative results (HTTP errors,
// empty bodies) are NOT cached — those failures may be transient and
// re-trying next run is correct.
function cacheRoot() {
  if (process.env.ADR_CACHE_DIR) return path.resolve(process.env.ADR_CACHE_DIR);
  return path.join(os.homedir(), ".adr", "cache");
}

function cachePathFor(url) {
  const bare = String(url).split("#")[0];
  const hash = createHash("sha256").update(bare).digest("hex");
  return path.join(cacheRoot(), hash.slice(0, 2), `${hash}.json`);
}

function cacheTtlMs() {
  const days = Number(process.env.ADR_CACHE_TTL_DAYS || 7);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return days * 24 * 60 * 60 * 1000;
}

function cacheDisabled() {
  return process.env.ADR_CACHE_DISABLE === "1" || cacheTtlMs() === 0;
}

async function readUrlCache(url) {
  if (cacheDisabled()) return null;
  const filePath = cachePathFor(url);
  try {
    const raw = await readFile(filePath, "utf8");
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== "object" || typeof entry.text !== "string") return null;
    const fetchedAt = Date.parse(entry.fetched_at);
    if (!Number.isFinite(fetchedAt)) return null;
    const age = Date.now() - fetchedAt;
    if (age > cacheTtlMs()) return null;
    return entry.text;
  } catch {
    return null;
  }
}

async function writeUrlCache(url, text) {
  if (cacheDisabled()) return;
  if (typeof text !== "string" || text.length === 0) return;
  try {
    const filePath = cachePathFor(url);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        url: String(url).split("#")[0],
        fetched_at: nowIso(),
        text
      })
    );
  } catch {
    // Cache write failures are non-fatal — we already have the text in
    // memory and the caller can proceed without persistence.
  }
}

async function openUrl(url, flags) {
  if (!/^https?:\/\//i.test(url)) return "";

  const cached = await readUrlCache(url);
  if (cached !== null) return cached;

  const response = await fetch(url, {
    headers: {
      "user-agent": "Beevibe-ADR/0.2 (+https://github.com/beevibe-ai/architecture-deep-research)"
    },
    signal: AbortSignal.timeout(Number(flags["fetch-timeout-ms"] || 20_000))
  });
  if (!response.ok) return "";
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  const cleaned = contentType.includes("html") ? htmlToText(text) : normalizeWhitespace(text);
  await writeUrlCache(url, cleaned);
  return cleaned;
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

// Aggregator / SEO-content domains worth recognizing as such. Matched
// BEFORE engineering_writeup so the generic /blog|engineering/ regex
// doesn't accidentally promote listicles to "engineering writeup" quality.
// Curated narrowly — adding sites here drops their score below the
// promotion gate. Bias toward false negatives.
const AGGREGATOR_DOMAIN_RE = /\b(geeksforgeeks\.org|tutorialspoint\.com|javatpoint\.com|journaldev\.com|simplilearn\.com|educative\.io|byjus\.com|netsuite\.com\/insights|btsta(?:gregator|ggregator)\.com|wisp\.(?:cms|app)|baeldung\.com|topcoder\.com)/i;

function classifySource(url) {
  if (!url) return "unknown";
  if (/^mcp:\/\//i.test(url)) return "private_corpus";
  if (AGGREGATOR_DOMAIN_RE.test(url)) return "aggregator";
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
    aggregator: 0.15,
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
  // Source quality is the dominant signal. Keyword overlap is noisy (an
  // aggregator listicle can hit 12 keywords just by listing them in a TOC
  // without saying anything substantive) so weight it less. One Notion or
  // Linear postmortem is genuinely worth more than 50 aggregator hits, and
  // the score should reflect that.
  const score =
    sourceQuality(sourceType) * 0.55 +
    Math.min(keywordHits.length / 12, 1) * 0.20 +
    Math.min(claims.length / 4, 1) * 0.10 +
    claimConfidence * 0.15;
  return {
    keyword_hits: keywordHits,
    score: Number(score.toFixed(3))
  };
}

// Normalize text for substring matching so the quote check tolerates minor
// whitespace and quote-mark differences between the model's quote and the
// excerpt it came from. Lowercase + collapse whitespace + strip smart quotes.
function normalizeForQuoteCheck(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[‘’‚‛′‵]/g, "'")
    .replace(/[“”„‟″‶]/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractClaims({ context, task, source }) {
  const result = await callLlmJson({
    label: "source_claim_extractor",
    system: [
      "You extract architecture-decision evidence from sources for the decision focus:",
      `  domain:   "${context.domain}"`,
      `  decision: "${context.decision}"`,
      `  kind:     ${context.decision_kind || "family"}`,
      "",
      "Return ONLY claims that are directly supported by the supplied excerpt.",
      "Do not add static architecture knowledge. Do not infer beyond the text.",
      "",
      "EVIDENCE GROUNDING — the hardest rule:",
      "Every claim MUST carry a `quote` field that is a LITERAL substring of the",
      "supplied excerpt — 20 to 300 characters — that backs the claim. If you",
      "cannot find a literal substring of the excerpt that backs the claim, do",
      "NOT emit the claim. We will programmatically verify that quote is a",
      "substring of the excerpt and drop any claim that fails. A polished",
      "paraphrase is worth zero. We need the actual words from the page.",
      "",
      "DECISION RELEVANCE — the second-hardest rule:",
      "Every claim MUST set `relevance` to one of:",
      "  - on_topic:  this claim bears directly on the decision focus above",
      "  - tangential: same general area but does not discriminate candidates",
      "  - off_topic: the source talks about a different architecture decision",
      "Emit off_topic claims only when you genuinely cannot tell. The pipeline",
      "drops off_topic claims downstream. If most of the excerpt is off_topic,",
      "return an empty claims array — that is a valid answer.",
      "",
      "ARCHITECTURE FAMILY — must be MACRO-level:",
      "architecture_family must name a MACRO-level architectural family or, in",
      "concrete decision-kind mode, a specific named product/vendor/library.",
      "Roll up low-level concepts under their parent macro family. Examples:",
      "- 'Leiden Community Detection', 'Hierarchical Clustering'",
      "  → architecture_family: 'GraphRAG'",
      "- 'Top-K Vector Search', 'HNSW Index', 'BM25 Reranker'",
      "  → architecture_family: 'Vector RAG'",
      "- 'ReAct Tool Use', 'Orchestrator-Worker'",
      "  → architecture_family: 'Agentic Retrieval'",
      "- For a 'concrete' kind, prefer named products: 'Clerk', 'Auth0', 'WorkOS', 'BullMQ'.",
      "",
      "Every architecture_family must be a plausible answer to the decision",
      `focus above. If a claim's family is not a plausible answer to "${context.decision}",`,
      "set architecture_family: 'unspecified'. Do not invent new family names",
      "when a canonical one fits.",
      "",
      "FIELD CONSTRAINTS:",
      "- polarity MUST be exactly one of: supports, rejects, neutral",
      "- confidence MUST be a number from 0 to 1",
      "- quote MUST be a literal substring of the excerpt, 20-300 chars",
      "- relevance MUST be exactly one of: on_topic, tangential, off_topic",
      "",
      "Output JSON with {claims:[{claim, quote, architecture_family, polarity, relevance, domain_conditions, risk_or_fit, confidence}]}."
    ].join("\n"),
    user: JSON.stringify({
      domain: context.domain,
      decision: context.decision,
      decision_kind: context.decision_kind || "family",
      task,
      source: {
        title: source.title,
        url: source.url,
        source_type: source.source_type,
        excerpt: source.excerpt
      }
    })
  });

  const excerptHaystack = normalizeForQuoteCheck(source.excerpt);

  return toArray(result.claims)
    .map((claim) => {
      const relevance = String(claim.relevance || "on_topic").trim().toLowerCase();
      return {
        claim: String(claim.claim || "").trim(),
        quote: String(claim.quote || "").trim(),
        architecture_family: String(claim.architecture_family || "unspecified").trim(),
        polarity: normalizePolarity(claim.polarity),
        relevance:
          relevance === "on_topic" || relevance === "tangential" || relevance === "off_topic"
            ? relevance
            : "on_topic",
        domain_conditions: toArray(claim.domain_conditions).map(String).slice(0, 6),
        risk_or_fit: String(claim.risk_or_fit || "").trim(),
        confidence: clampNumber(claim.confidence, { min: 0, max: 1, fallback: 0.5 })
      };
    })
    .filter((claim) => {
      if (!claim.claim) return false;
      // Off-topic claims are dropped: the extractor said the source talks
      // about a different decision than the one we're researching.
      if (claim.relevance === "off_topic") return false;
      // Quote must be a literal substring of the excerpt (whitespace- and
      // quote-mark-normalized). This is the grounding gate: it forces the
      // extractor to admit when a source does not actually support a claim.
      // Hallucinated quotes are dropped.
      if (!claim.quote || claim.quote.length < 10) return false;
      const needle = normalizeForQuoteCheck(claim.quote);
      if (!excerptHaystack.includes(needle)) return false;
      return true;
    });
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
  await appendEvent(outDir, "research_search_completed", {
    task_id: task.id,
    round,
    query,
    result_count: liveResults.length
  });
  for (const result of liveResults) {
    if (!result.url || seenUrls.has(result.url)) continue;
    seenUrls.add(result.url);

    const source_type = classifySource(result.url);

    // Dropped: research_source_fetching event. The companion
    // research_source_processed event below carries everything in one,
    // so the per-source event count goes from 4 to 1. Without this cut,
    // 30 sources × 4 events = 120 events drowns out the high-signal beats.

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
    if (!excerpt || excerpt.length < 120) {
      await appendEvent(outDir, "research_source_skipped", {
        task_id: task.id,
        round,
        url: result.url,
        title: result.title || result.url,
        source_type,
        reason: "excerpt_too_short_or_empty"
      });
      continue;
    }
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

    // Single per-source event with everything: fetch result + extracted
    // claims. Replaces the previous 4 events (fetching / fetched /
    // claims_extracting / claims_extracted) so 30 sources fire 30 events
    // instead of 120 — chat surfaces stop auto-throttling.
    await appendEvent(outDir, "research_source_processed", {
      task_id: task.id,
      round,
      url: result.url,
      title: result.title || result.url,
      source_type,
      fetch_status: fetchStatus,
      text_bytes: Buffer.byteLength(sourceText || "", "utf8"),
      claim_count: claims.length,
      score: scored.score,
      // Concrete content the user can read: page preview + top claims.
      // Two short lines beat eight noisy events.
      preview: String(sourceText || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240),
      claims_preview: claims.slice(0, 3).map((c) => ({
        family: c.architecture_family,
        polarity: c.polarity,
        claim: String(c.claim || "").slice(0, 200),
        quote: String(c.quote || "").slice(0, 180)
      }))
    });

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

function deriveComparisonAxes(context, options = {}) {
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

  // Every query_shape becomes an axis automatically. The previous static
  // list (multi_hop_relational, audit_traceability, ...) silently dropped
  // user-specific shapes like `tenant_filtered_vector_search` or
  // `tenant_hard_delete`. If the strategic context surfaced it as a query
  // shape, it matters enough to score against.
  const seenShapeAxes = new Set();
  for (const shape of toArray(context.query_shapes)) {
    if (!shape || typeof shape !== "object") continue;
    const name = String(shape.name || "").trim();
    if (!name) continue;
    const slug = slugify(name);
    if (!slug || seenShapeAxes.has(slug)) continue;
    seenShapeAxes.add(slug);
    const evidenceLine = toArray(shape.evidence).map(String).filter(Boolean).join(", ");
    axes.push({
      id: `query_shape_${slug}`,
      label: `Query shape: ${name}`,
      rationale: evidenceLine
        ? `Strategic context: ${evidenceLine}`
        : `Strategic context surfaced "${name}" as a query shape the architecture must support.`
    });
  }

  // Every risk_invariant becomes an axis. Things like "tenants must hard-
  // delete agent memory" only become matrix columns when each candidate is
  // scored against the invariant explicitly. Otherwise the synthesis
  // compares candidates on things the user didn't ask about and misses
  // things they did.
  const seenInvariantAxes = new Set();
  for (const invariant of toArray(context.risk_invariants)) {
    const text = typeof invariant === "string" ? invariant.trim() : "";
    if (!text) continue;
    const slug = slugify(text.slice(0, 64));
    if (!slug || seenInvariantAxes.has(slug)) continue;
    seenInvariantAxes.add(slug);
    axes.push({
      id: `risk_invariant_${slug}`,
      label: `Risk invariant: ${text.length > 80 ? text.slice(0, 77) + "..." : text}`,
      rationale: text
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

  // Concrete-mode decisions compare specific products. Add vendor-grade axes
  // that the LLM cell-filler can score against. These are no-ops in family
  // mode (family-level evidence rarely speaks to vendor-specific concerns
  // like pricing or lock-in).
  if (context.decision_kind === "concrete") {
    axes.push(
      {
        id: "pricing_model",
        label: "Pricing model + free tier",
        rationale: "Cost structure, free tier limits, predictability at scale."
      },
      {
        id: "vendor_lock_in",
        label: "Vendor lock-in risk",
        rationale: "Data portability, proprietary APIs, exit cost."
      },
      {
        id: "sdk_integration_quality",
        label: "SDK + integration quality",
        rationale: "Maturity of official SDKs, integration patterns, developer experience."
      },
      {
        id: "on_prem_self_host",
        label: "Self-host / on-prem availability",
        rationale: "Can the product run inside the user's own infrastructure?"
      },
      {
        id: "ecosystem_health",
        label: "Ecosystem + community health",
        rationale: "Active maintainers, community size, momentum, recent incidents."
      }
    );
  }

  // Discovered stack from `adr discover` becomes a first-class axis. If the
  // user's repo already runs Postgres, a candidate that builds on Postgres
  // (pgvector) gets credit for "fits the existing stack"; a candidate that
  // requires a new managed service (Pinecone) gets a hit. This makes
  // "what's already installed" a real scoring factor, not flavor text.
  const discoveredStack = toArray(options.discoveredStack)
    .map((s) => (typeof s === "string" ? s : s?.name || ""))
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (discoveredStack.length > 0) {
    axes.push({
      id: "fits_existing_stack",
      label: "Fits existing stack",
      rationale: `Repo scan surfaced existing stack: ${discoveredStack.join(", ")}. Candidates that extend this stack score 'strong'; those requiring new infrastructure score 'weak'.`,
      discovered_stack: discoveredStack
    });
  }

  // Discovered anti-patterns from `adr discover` become first-class axes so
  // the comparison matrix can score candidates against the team's explicit
  // rejections. Cells filled by the LLM with the synthetic private_corpus
  // evidence items that share the same architecture_family.
  const discoveredAntipatterns = toArray(options.discoveredAntipatterns);
  for (const ap of discoveredAntipatterns) {
    if (!ap || typeof ap !== "object" || typeof ap.name !== "string" || !ap.name.trim()) {
      continue;
    }
    const slug = slugify(ap.name);
    if (!slug) continue;
    const cites = toArray(ap.evidence_cite).map(String).filter(Boolean);
    const reason = typeof ap.reason === "string" && ap.reason.trim() ? ap.reason.trim() : "";
    axes.push({
      id: `team_antipattern_${slug}`,
      label: `Avoids: ${ap.name}`,
      rationale: `Team has explicitly rejected this${reason ? ` — ${reason}` : ""}. Cited: ${
        cites.length > 0 ? cites.join(", ") : "(no citations recorded)"
      }`
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
      "For each (candidate, axis) cell, return a verdict and a summary.",
      "",
      "VERDICTS: 'strong' | 'mixed' | 'weak' | 'no_evidence'.",
      "Cite specific evidence_ids that justify the cell. If no evidence",
      "supports a verdict, return 'no_evidence' with empty evidence_citations.",
      "Be conservative: only mark 'strong' or 'weak' when claims are clearly",
      "supportive or rejecting; otherwise 'mixed' or 'no_evidence'.",
      "Do not invent evidence. Do not cite an evidence_id that does not",
      "appear in the supplied pool.",
      "",
      "QUANTITATIVE CELL CONTENT — the most important rule:",
      "When a cited claim or excerpt contains numbers, KEEP THE NUMBERS in",
      "the cell summary verbatim. Do NOT collapse to vague prose. Examples:",
      "  WRONG: 'pgvector achieves sub-100ms p95 latency for production use'",
      "  RIGHT: 'pgvector HNSW index: ~25ms p95 on 1M 768-dim vectors,",
      "         IVFFlat: ~80ms p95. Source: pgvector benchmark notes [12].'",
      "",
      "  WRONG: 'Pinecone scales well for large vector workloads'",
      "  RIGHT: 'Pinecone p2 pod: 1000 QPS at <10ms p95 / 5M vectors per pod;",
      "         $70-$120/mo per pod tier. Hard limits: 40k metadata fields,",
      "         128k vectors per namespace. [4][7]'",
      "",
      "Keep these where the source provides them:",
      "  - latency numbers (p50, p95, p99) and the load profile that produced",
      "    them (QPS, dataset size, dimensions, index type, hardware)",
      "  - cost figures (per-month, per-tier, per-query) and which tier",
      "  - scale limits (max vectors, max QPS, max metadata, max collections)",
      "  - version + maturity signals (release year, commit cadence, contributors)",
      "  - RPS quotas, rate limits, retry semantics",
      "",
      "Cells without numbers when the cited source contains them are wrong.",
      "If the source is genuinely qualitative (a design philosophy post),",
      "say so explicitly: 'Qualitative — no benchmarks in cited source.'",
      "",
      "AXIS-SPECIFIC GUIDANCE:",
      "  fits_existing_stack: use the user's stack list (provided in axis",
      "    rationale) to give a 'strong' verdict if the candidate extends",
      "    that stack and 'weak' if it requires new infra. This axis is",
      "    deterministic when you can name the stack overlap.",
      "  query_shape_* and risk_invariant_*: directly answer whether the",
      "    candidate supports that specific shape / preserves that invariant.",
      "",
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
  evidenceItems,
  discoveredAntipatterns = [],
  discoveredStack = []
}) {
  const axes = deriveComparisonAxes(context, { discoveredAntipatterns, discoveredStack });
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

  const promotedCandidates = toArray(matrix.candidates).filter(
    (c) => c.promotion_status === "evidence_backed_candidate"
  );
  const promotedNames = promotedCandidates.map((c) => c.name);

  // Round-robin balance: every promoted candidate gets EXACTLY one
  // adversarial task. This stops the "Milvus looks clean by absence of
  // adversarial probing" failure mode. The LLM is told the exact target
  // distribution; post-processing enforces it by padding any candidate the
  // LLM skipped with a generic per-candidate fallback probe.
  const targetTasksPerCandidate = 1;

  const result = await callLlmJson({
    label: "adversarial_research_planner",
    system: [
      "You are the adversarial research planner for Architecture Deep Research.",
      "",
      "Distribute probes EVENLY across candidates. Each promoted candidate",
      `must get exactly ${targetTasksPerCandidate} adversarial task.`,
      "An underprobed candidate looks artificially clean in the comparison",
      "matrix because no one looked for its weaknesses — never let that",
      "happen.",
      "",
      "For each candidate, generate one task that hunts for the strongest",
      "case AGAINST it: production failure stories, latency or scale",
      "incidents, lineage / audit limitations, ops complexity, ecosystem",
      "decline, recent outages, deprecation signals.",
      "",
      "If a candidate has many empty cells in the matrix (verdict",
      "'no_evidence'), aim the task at the most empty axis for that",
      "candidate so the cycle fills the matrix, not just adversarial gaps.",
      "",
      "Each task needs {id, title, objective, search_queries:[string],",
      "source_targets:[string], target_candidate, target_axis?}.",
      "target_candidate MUST be one of the candidate names below.",
      "",
      "Output JSON with {tasks:[...]}."
    ].join("\n"),
    user: JSON.stringify({
      domain: context.domain,
      decision: context.decision,
      candidate_distribution_target: {
        tasks_per_candidate: targetTasksPerCandidate,
        candidates: promotedNames,
        total_tasks: promotedNames.length * targetTasksPerCandidate
      },
      candidates: promotedCandidates.map((candidate) => ({
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

  // Parse the LLM output and group by target_candidate.
  const parsed = toArray(result.tasks).map((task, index) => ({
    id: task.id || `X${index + 1}`,
    title: String(task.title || `Adversarial task ${index + 1}`),
    objective: String(task.objective || ""),
    search_queries: toArray(task.search_queries).map(String).slice(0, 4),
    source_targets: toArray(task.source_targets).map(String).slice(0, 5),
    success_criteria: toArray(task.success_criteria).map(String).slice(0, 5),
    target_candidate: String(task.target_candidate || "").trim() || null,
    target_axis: String(task.target_axis || "").trim() || null
  })).filter((task) => task.search_queries.length > 0);

  // Round-robin enforcement: distribute parsed tasks so each candidate
  // gets at most targetTasksPerCandidate. Drop overflow tasks targeting
  // already-covered candidates. Pad missing candidates with a synthesized
  // fallback probe — "find production failure modes of <X>" — using the
  // candidate's label.
  const tasksByCandidate = new Map();
  const orphanTasks = [];
  for (const task of parsed) {
    const slug = slugify(task.target_candidate || "");
    if (!slug || !promotedNames.map(slugify).includes(slug)) {
      orphanTasks.push(task);
      continue;
    }
    const existing = tasksByCandidate.get(slug) || [];
    if (existing.length < targetTasksPerCandidate) {
      existing.push(task);
      tasksByCandidate.set(slug, existing);
    }
  }
  // Pad missing.
  for (const candidate of promotedCandidates) {
    const slug = slugify(candidate.name);
    if ((tasksByCandidate.get(slug) || []).length >= targetTasksPerCandidate) continue;
    tasksByCandidate.set(slug, [
      ...(tasksByCandidate.get(slug) || []),
      {
        id: `X_pad_${slug}`,
        title: `Adversarial probe for ${candidate.label || candidate.name}`,
        objective: `Find the strongest case AGAINST ${candidate.label || candidate.name}: production failures, scale or latency incidents, deprecation signals, ecosystem decline.`,
        search_queries: [
          `${candidate.label || candidate.name} production failures site:news.ycombinator.com`,
          `${candidate.label || candidate.name} outage postmortem`,
          `${candidate.label || candidate.name} limitations github issues`
        ],
        source_targets: ["news.ycombinator.com", "github.com"],
        success_criteria: [`Find a real-world failure mode of ${candidate.name}`],
        target_candidate: candidate.name,
        target_axis: null,
        balancer_padded: true
      }
    ]);
  }

  // Interleave by candidate so the parallel agent pool runs the round-robin
  // order (one probe per candidate concurrently, then the next round).
  const balancedTasks = [];
  for (let round = 0; round < targetTasksPerCandidate; round += 1) {
    for (const candidate of promotedCandidates) {
      const slug = slugify(candidate.name);
      const group = tasksByCandidate.get(slug) || [];
      if (group[round]) balancedTasks.push(group[round]);
    }
  }

  return {
    version: VERSION,
    architecture: "adversarial_per_candidate",
    max_parallel_research_agents: MAX_PARALLEL_RESEARCH_AGENTS,
    balancing: {
      target_tasks_per_candidate: targetTasksPerCandidate,
      candidates_probed: balancedTasks.length,
      llm_emitted: parsed.length,
      orphan_dropped: orphanTasks.length,
      padded_for_skipped_candidates: balancedTasks.filter((t) => t.balancer_padded).length
    },
    tasks: balancedTasks
  };
}

async function synthesizeArchitectureSpec({
  context,
  knowledgeMap,
  evidenceItems,
  comparisonMatrix,
  priorCritique = null,
  priorSpec = null
}) {
  const promotedNames = toArray(knowledgeMap?.promoted_candidates).map((c) => c.name);
  const promotedSet = new Set(promotedNames);
  const HUMAN_REVIEW = "requires_human_architecture_review";
  const RANKED_OPTIONS_SENTINEL = "ranked_options";

  const kind = context.decision_kind || "family";
  const isResynth = Boolean(priorCritique && priorSpec);
  const result = await callLlmJson({
    label: isResynth ? "architecture_synthesis_agent_resynth" : "architecture_synthesis_agent",
    system: [
      "You are the Architecture Deep Research synthesis agent.",
      "",
      "Your job is NOT to pick a single winning architecture. Architecture",
      "decisions are tradeoffs. Your job is to produce a RANKED OPTION SET",
      "with explicit, evidence-grounded tradeoffs, plus an optional",
      "recommendation ONLY when the comparison matrix shows one option",
      "clearly dominates.",
      "",
      kind === "concrete"
        ? "Each option in this run is a SPECIFIC PRODUCT / VENDOR / LIBRARY (e.g. \"Clerk\", \"Auth0\", \"BullMQ\")."
        : "Each option in this run is an architecture FAMILY / PATTERN.",
      "",
      "RANKED OPTIONS — the primary output:",
      "For each promoted_candidate from the knowledge_map, produce one option:",
      "  {",
      "    name,                  // canonical id from promoted_candidates",
      "    label,                 // human-readable title",
      "    summary,               // 2-3 sentences, grounded in evidence",
      "    when_to_pick,          // 2-4 conditions under which this is the right choice",
      "    when_not_to_pick,      // 2-4 conditions under which it isn't",
      "    strong_axes,           // axis ids where the matrix marks this option `strong`",
      "    weak_axes,             // axis ids where the matrix marks this option `weak`",
      "    risks,                 // 2-5 concrete risks tied to this option",
      "    required_invariants,   // invariants a coding agent must honor IF this option is picked",
      "    forbidden_topologies,  // patterns/products to avoid when this option is picked",
      "    evidence_citations,    // citation_ids supporting this option",
      "    confidence             // 0-1, how strongly the evidence backs this option",
      "  }",
      "",
      "DO NOT invent options. Every option's `name` MUST appear in the",
      `promoted_candidates list below: [${promotedNames.map((n) => `"${n}"`).join(", ")}].`,
      "Options for candidates that did NOT clear the promotion gate are not",
      "included in ranked_options — they appear in candidate_topologies as",
      "decision: \"rejected\" (or \"deferred\").",
      "",
      "MODE — decide how decisive to be:",
      "- \"recommended\": ONE option clearly dominates. It must be strong on",
      "  multiple axes that matter for this decision AND the others must be",
      "  weak or no_evidence on at least one critical axis. Populate",
      "  recommendation = {name, why, when_this_breaks}. when_this_breaks",
      "  lists the conditions under which the user should pick a different",
      "  option from ranked_options.",
      "- \"ranked_options\": multiple options are viable with genuine",
      "  tradeoffs. No single option dominates. Set recommendation = null.",
      "  Do NOT invent a recommendation to seem decisive.",
      "- \"deferred\": no candidates cleared the promotion gate. Set",
      "  ranked_options = [] and recommendation = null. This run did not",
      "  produce enough evidence to identify viable options.",
      "",
      "COMMITMENT RULE — hedging is dishonest when the field narrows:",
      "The user already had their constraints applied via the hard-constraint",
      "filter BEFORE you saw this candidate pool. Every option here passed",
      "their must-haves. So:",
      "  - If only 1 option survived, you MUST recommend it. There is",
      "    nothing else to hedge against.",
      "  - If 2 options survived and one dominates on the axes the user",
      "    actually cares about, recommend it. \"Both have tradeoffs\" is the",
      "    wrong answer when the user told you which tradeoffs they accept.",
      "  - Only fall to \"ranked_options\" when 3+ options survive AND the",
      "    dominance pattern is genuinely ambiguous across multiple axes.",
      "",
      "Refusing to recommend in a narrow field rewards intellectual hedging",
      "over making the call the evidence supports. Don't do that.",
      "",
      promotedNames.length > 0
        ? `Promoted candidates available for ranked_options: [${promotedNames.map((n) => `"${n}"`).join(", ")}]. (Already filtered against hard constraints — every option here passed the user's must-haves.)`
        : "NO candidates cleared the promotion gate. mode MUST be \"deferred\".",
      "",
      "EVIDENCE GROUNDING:",
      "- Use comparison_matrix as the primary input. An axis is \"strong\" for",
      "  an option only when the matrix says so with cited evidence.",
      "- No static pattern library. No invented evidence.",
      "- Citation IDs in evidence_citations must exist in the evidence pool.",
      "",
      kind === "concrete"
        ? "Concrete-mode rules: each option is a specific product. when_to_pick / when_not_to_pick should reference vendor-specific concerns (pricing model, vendor lock-in, SDK quality, on-prem availability, ecosystem health) alongside fit-for-purpose."
        : "Family-mode rules: each option is an architecture family. forbidden_topologies (per option) should list families/patterns that conflict with that option's invariants.",
      "",
      ...(isResynth
        ? [
            "RE-SYNTHESIS MODE — the previous synthesis was critiqued.",
            "Read prior_spec and prior_critique below. Your job is to IMPROVE",
            "the option set:",
            "- If the critique says two options are duplicates, merge them.",
            "- If the critique says an option's strong_axes is unsupported by",
            "  its citations, weaken that option (demote from recommended,",
            "  add the failure mode to weak_axes).",
            "- If the critique says the recommendation isn't actually backed",
            "  by dominant axes, drop the recommendation (set mode =",
            "  \"ranked_options\", recommendation = null).",
            "- If the critique says an obvious option is missing from the",
            "  matrix, you cannot add it here — note in summary that further",
            "  research is needed.",
            "Acknowledge in summary which critique issues you addressed and how.",
            ""
          ]
        : []),
      "Output JSON: {decision: {id, title, status, mode, ranked_options, recommendation, summary}, domain_model, evidence_summary}."
    ].join("\n"),
    user: JSON.stringify({
      context,
      knowledge_map: knowledgeMap,
      comparison_matrix: comparisonMatrix,
      ...(isResynth
        ? {
            prior_spec: {
              mode: priorSpec.decision?.mode,
              recommendation: priorSpec.decision?.recommendation,
              ranked_options: toArray(priorSpec.decision?.ranked_options).map((o) => ({
                name: o.name,
                strong_axes: o.strong_axes,
                weak_axes: o.weak_axes
              })),
              summary: priorSpec.decision?.summary
            },
            prior_critique: {
              issues: priorCritique.issues,
              summary: priorCritique.summary
            }
          }
        : {}),
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

  // Parse the model's ranked_options, filtering names that don't appear in
  // promoted_candidates. The synthesizer is forbidden from inventing options.
  const rawRanked = toArray(result.decision?.ranked_options);
  const dedupSeen = new Set();
  const rankedOptions = [];
  for (const opt of rawRanked) {
    const name = slugify(String(opt.name || "").trim());
    if (!name) continue;
    if (!promotedSet.has(name)) continue; // hallucinated option; drop
    if (dedupSeen.has(name)) continue;
    dedupSeen.add(name);
    rankedOptions.push({
      name,
      label: String(opt.label || titleCase(name)),
      summary: String(opt.summary || ""),
      when_to_pick: toArray(opt.when_to_pick).map(String).filter(Boolean).slice(0, 6),
      when_not_to_pick: toArray(opt.when_not_to_pick).map(String).filter(Boolean).slice(0, 6),
      strong_axes: toArray(opt.strong_axes).map(String).filter(Boolean),
      weak_axes: toArray(opt.weak_axes).map(String).filter(Boolean),
      risks: toArray(opt.risks).map(String).filter(Boolean),
      required_invariants: toArray(opt.required_invariants).map(String).filter(Boolean),
      forbidden_topologies: toArray(opt.forbidden_topologies).map(String).filter(Boolean),
      evidence_citations: toArray(opt.evidence_citations)
        .map(Number)
        .filter((id) => Number.isFinite(id) && validCitationIds.has(id)),
      confidence: clampNumber(opt.confidence, { min: 0, max: 1, fallback: 0.5 })
    });
  }

  // Parse the recommendation. The model may return null, an object, or a
  // hallucinated name; normalize to either null or {name, why, when_this_breaks}
  // where name is constrained to the ranked_options set.
  const rankedNames = new Set(rankedOptions.map((o) => o.name));
  const rawRec = result.decision?.recommendation;
  let recommendation = null;
  if (rawRec && typeof rawRec === "object" && rawRec.name) {
    const recName = slugify(String(rawRec.name));
    if (rankedNames.has(recName)) {
      recommendation = {
        name: recName,
        why: String(rawRec.why || "").trim(),
        when_this_breaks: toArray(rawRec.when_this_breaks).map(String).filter(Boolean).slice(0, 6)
      };
    }
  }

  // Derive mode. Honor the model's declared mode when consistent with the
  // parsed structure; override when the structure says otherwise.
  let mode;
  if (rankedOptions.length === 0) {
    mode = "deferred";
    recommendation = null;
  } else if (recommendation) {
    mode = "recommended";
  } else {
    mode = "ranked_options";
  }

  // Commitment safety net: when the field genuinely narrows (after hard-
  // constraint filtering), refusing to recommend is dishonest. The synthesizer
  // prompt is told this, but it still over-defaults to "ranked_options" some
  // fraction of the time. Deterministic post-processing forces commitment when:
  //   1. Only 1 option survived — always recommend it. There is nothing to
  //      hedge against; the user's constraints already narrowed the field.
  //   2. 2 options survived AND one has a clear lead on net strong_axes
  //      (strong_axes.length - weak_axes.length differs by >=2) — recommend
  //      the leader. Close 2-way ties stay as ranked_options.
  if (mode === "ranked_options") {
    if (rankedOptions.length === 1) {
      const only = rankedOptions[0];
      mode = "recommended";
      recommendation = {
        name: only.name,
        why: `Only viable option after constraint filtering. Hedging would be dishonest here — every other promoted candidate failed at least one must-have constraint or did not survive critique.`,
        when_this_breaks: [
          "If you relax a must-have constraint in constraints.json and re-run, additional options may surface."
        ]
      };
    } else if (rankedOptions.length === 2) {
      const score = (o) => toArray(o.strong_axes).length - toArray(o.weak_axes).length;
      const sorted = [...rankedOptions].sort((a, b) => score(b) - score(a));
      const lead = score(sorted[0]) - score(sorted[1]);
      if (lead >= 2) {
        mode = "recommended";
        recommendation = {
          name: sorted[0].name,
          why: `Of the two surviving options, ${sorted[0].label || sorted[0].name} leads on ${score(sorted[0])} net strong axes vs ${sorted[1].label || sorted[1].name}'s ${score(sorted[1])}.`,
          when_this_breaks: [
            `If ${sorted[1].label || sorted[1].name}'s weak axes (${toArray(sorted[1].weak_axes).join(", ") || "none recorded"}) turn out not to matter for your case, the gap closes.`
          ]
        };
      }
    }
  }

  // Back-compat: selected_topology. New code reads decision.mode +
  // ranked_options + recommendation directly, but a lot of tooling and the
  // citation-audit pipeline keys off selected_topology. Map cleanly:
  //   recommended    → recommendation.name
  //   ranked_options → literal "ranked_options"
  //   deferred       → "requires_human_architecture_review"
  let selectedTopology;
  if (mode === "recommended") selectedTopology = recommendation.name;
  else if (mode === "ranked_options") selectedTopology = RANKED_OPTIONS_SENTINEL;
  else selectedTopology = HUMAN_REVIEW;

  // candidate_topologies retains its existing shape but is now driven by
  // ranked_options. Every ranked option becomes a candidate with
  // decision: "selected" when recommended, else "considered". Promoted
  // candidates that the synthesizer DID NOT include in ranked_options are
  // recorded as "rejected" (the synthesizer chose not to surface them).
  const candidates = [];
  for (const opt of rankedOptions) {
    const isRecommended = recommendation && recommendation.name === opt.name;
    candidates.push({
      name: opt.name,
      label: opt.label,
      fit: opt.summary,
      risks: opt.risks,
      decision: isRecommended ? "selected" : "considered",
      evidence_citations: opt.evidence_citations,
      confidence: opt.confidence
    });
  }
  for (const promoted of promotedNames) {
    if (rankedNames.has(promoted)) continue;
    candidates.push({
      name: promoted,
      label: titleCase(promoted),
      fit: "Promoted by evidence but not surfaced in ranked_options by the synthesizer.",
      risks: [],
      decision: "rejected",
      evidence_citations: [],
      confidence: 0
    });
  }

  // Roll-up invariants / forbidden topologies for the back-compat fields.
  // When mode=recommended, mirror the recommended option. Else empty —
  // the caller must read per-option from ranked_options.
  let rollupInvariants = [];
  let rollupForbidden = [];
  if (mode === "recommended") {
    const recOption = rankedOptions.find((o) => o.name === recommendation.name);
    if (recOption) {
      rollupInvariants = recOption.required_invariants;
      rollupForbidden = recOption.forbidden_topologies;
    }
  }

  const decisionSummary = result.decision?.summary
    ? String(result.decision.summary)
    : mode === "deferred"
      ? "No candidates cleared the promotion gate. ADR did not produce viable options for this decision."
      : mode === "recommended"
        ? `One option (${recommendation.name}) dominates the comparison matrix; ${rankedOptions.length - 1} other viable options are recorded with their tradeoffs.`
        : `${rankedOptions.length} viable options identified with genuine tradeoffs. The right choice depends on team-side constraints.`;

  return {
    version: VERSION,
    decision: {
      id: result.decision?.id || "ADR-001",
      title: result.decision?.title || titleCase(context.decision),
      status: normalizeDecisionStatus(result.decision?.status),
      mode,
      ranked_options: rankedOptions,
      recommendation,
      selected_topology: selectedTopology,
      summary: decisionSummary,
      evidence_citations: toArray(result.decision?.evidence_citations)
        .map(Number)
        .filter((id) => Number.isFinite(id) && validCitationIds.has(id))
    },
    domain_model: {
      bounded_contexts: toArray(result.domain_model?.bounded_contexts),
      core_entities: toArray(result.domain_model?.core_entities),
      domain_invariants: toArray(result.domain_model?.domain_invariants)
    },
    candidate_topologies: candidates,
    guardrails: {
      forbidden_topologies: rollupForbidden,
      required_invariants: rollupInvariants,
      allowed_agentic_use: toArray(result.evidence_summary?.allowed_agentic_use),
      enforcement_notes: toArray(result.evidence_summary?.enforcement_notes)
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

async function buildEvaluationPack(context, spec, evidenceItems, comparisonMatrix = null) {
  const mode = spec.decision?.mode || "deferred";
  const rankedOptions = toArray(spec.decision?.ranked_options);

  // When the run is deferred (no viable options), there is nothing to
  // evaluate. Return an honest empty pack rather than fabricate test cases
  // against candidates the synthesizer rejected.
  if (mode === "deferred" || rankedOptions.length === 0) {
    return {
      version: VERSION,
      suite: slugify(context.domain || "architecture_deep_research_suite"),
      target_topologies: [],
      metrics: {},
      test_cases: [],
      mode: "deferred"
    };
  }

  const kind = context.decision_kind || "family";
  const result = await callLlmJson({
    label: "evaluation_pack_agent",
    system: [
      "You generate the domain evaluation pack for Architecture Deep Research.",
      "",
      "The pack is what a downstream coding agent runs AFTER implementing one",
      "of the options to verify the implementation actually delivers what the",
      "option claimed. It is NOT a generic test suite — it must be specific",
      "to this decision, this option set, and these claimed strong_axes.",
      "",
      `Decision: "${context.decision}" (kind: ${kind})`,
      `Domain: "${context.domain}"`,
      `Mode: ${mode}`,
      "",
      "INPUTS:",
      "- ranked_options[]: every viable option with its strong_axes, weak_axes,",
      "  when_to_pick, when_not_to_pick, required_invariants. Test cases should",
      "  cover every option's claimed strong_axes (verify the strength holds in",
      "  practice) AND the weak_axes (verify the weakness is documented, not a",
      "  surprise).",
      "- comparison_matrix: shows which axis verdicts came from evidence. Use",
      "  it to identify the axes that actually discriminate options.",
      "",
      "REQUIRED OUTPUT — be specific, not generic:",
      "- 6 to 12 test_cases. Each one must:",
      "    * name a target_topology from ranked_options[].name OR multiple",
      "      (a test that all options must pass)",
      "    * test a CONCRETE behavior with measurable acceptance_criteria",
      "    * NOT be a generic \"is the API up\" test",
      "  Examples by decision kind:",
      "    family / 'retrieval topology': multi-hop accuracy, citation lineage",
      "      depth, abstention rate on out-of-corpus queries, latency at p95",
      "    concrete / 'auth provider': tenant isolation under concurrent writes,",
      "      MFA enrollment flow, session revocation latency, SSO/SAML round",
      "      trip, on-prem deployment smoke if relevant",
      "    family / 'event bus topology': message ordering under partition,",
      "      at-least-once vs exactly-once, DLQ shape, replay-from-offset",
      "- 3 to 6 metrics. Each one has a numeric target and a definition. Use",
      "  rates in [0,1] for the well-known keys (deterministic_lineage_rate,",
      "  boundary_spill_tolerance, unsupported_answer_rate). Add",
      "  decision-specific metrics beyond those when relevant (p95_latency_ms,",
      "  tenant_isolation_violations_per_1m_requests, etc.)",
      "",
      "DO NOT return an empty test_cases array. DO NOT return an empty metrics",
      "object. If you cannot identify decision-specific tests, return tests",
      "anchored to the strong_axes / weak_axes from ranked_options.",
      "",
      "Output JSON: {suite: string, target_topologies: [string], metrics: object, test_cases: [object]}."
    ].join("\n"),
    user: JSON.stringify({
      context,
      mode,
      ranked_options: rankedOptions.map((o) => ({
        name: o.name,
        label: o.label,
        summary: o.summary,
        when_to_pick: o.when_to_pick,
        when_not_to_pick: o.when_not_to_pick,
        strong_axes: o.strong_axes,
        weak_axes: o.weak_axes,
        required_invariants: o.required_invariants,
        evidence_citations: o.evidence_citations
      })),
      recommendation: spec.decision?.recommendation || null,
      comparison_matrix: comparisonMatrix
        ? {
            axes: (comparisonMatrix.axes || []).map((a) => ({ id: a.id, label: a.label })),
            cells: (comparisonMatrix.cells || []).map((c) => ({
              candidate: c.candidate,
              axis_id: c.axis_id,
              verdict: c.verdict
            }))
          }
        : null,
      evidence: evidenceItems.slice(0, 10).map((item) => ({
        citation_id: item.citation_id,
        title: item.title,
        claims: item.claims
      }))
    })
  });

  const targetTopologies = toArray(result.target_topologies).length
    ? toArray(result.target_topologies)
    : rankedOptions.map((o) => o.name);

  return {
    version: VERSION,
    suite: result.suite || slugify(context.domain || "architecture_deep_research_suite"),
    target_topologies: targetTopologies,
    metrics: normalizeEvaluationMetrics(result.metrics),
    test_cases: normalizeEvaluationCases(result.test_cases).slice(0, 12),
    mode
  };
}

function normalizeEvaluationMetrics(metrics) {
  // Pass through whatever the evaluation_pack_agent produced. No fabricated
  // defaults — an empty metrics object honestly reflects "the agent did not
  // produce evaluation metrics" rather than seeding 0.98/0/0/2500 targets
  // that downstream consumers would read as research output.
  const source = metrics && typeof metrics === "object" && !Array.isArray(metrics) ? metrics : {};
  const RATE_KEYS = new Set([
    "deterministic_lineage_rate",
    "boundary_spill_tolerance",
    "unsupported_answer_rate"
  ]);
  const normalized = {};
  for (const [key, value] of Object.entries(source)) {
    let target;
    let extras = {};
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target = finiteNumber(value.target, null);
      extras = value;
    } else {
      target = finiteNumber(value, null);
    }
    if (target === null) continue;
    if (RATE_KEYS.has(key)) {
      target = clampNumber(target, { min: 0, max: 1, fallback: target });
    }
    normalized[key] = { ...extras, target };
  }
  return normalized;
}

function normalizeEvaluationCases(testCases) {
  return toArray(testCases)
    .map((testCase, index) => {
      const out = {
        id: testCase.id || `TC-${String(index + 1).padStart(3, "0")}`,
        type: testCase.type || "architecture_invariant",
        question: String(testCase.question || "").trim(),
        expected_entities: toArray(testCase.expected_entities).map(String),
        acceptance_criteria: toArray(testCase.acceptance_criteria).map(String)
      };
      if (Number.isInteger(testCase.minimum_citation_depth)) {
        out.minimum_citation_depth = testCase.minimum_citation_depth;
      }
      const rule = String(testCase.abstention_rule || "").trim();
      if (rule) out.abstention_rule = rule;
      return out;
    })
    .filter((testCase) => testCase.question);
}

function buildGuardrails(spec) {
  const mode = spec.decision?.mode || "deferred";
  const rankedOptions = toArray(spec.decision?.ranked_options);
  const recommendation = spec.decision?.recommendation || null;
  const allowedAgenticUse = toArray(spec.guardrails?.allowed_agentic_use);

  // Deferred: no options were produced. Be honest — there is nothing for a
  // coding agent to enforce yet.
  if (mode === "deferred" || rankedOptions.length === 0) {
    return `# Agent Guardrails: ${spec.decision.title}

## No options identified

ADR did not produce viable options for this decision. The evidence collected
did not clear the promotion gate for any candidate. There is nothing to
enforce.

## What to do next

- Re-run with sharper context (better PRD, narrower decision focus).
- Or run \`adr supersede <out-dir>\` after collecting more evidence.
- Do NOT implement against generic invariants — pick an option first.
`;
  }

  const header = mode === "recommended"
    ? `Recommended option: **${recommendation.name}** (one of ${rankedOptions.length} viable options below).`
    : `Mode: **ranked_options** — ${rankedOptions.length} viable options with genuine tradeoffs. The caller picks one option and applies the matching block below.`;

  const optionBlocks = rankedOptions
    .map((opt) => {
      const isRec = recommendation && recommendation.name === opt.name;
      const recTag = isRec ? " *(recommended)*" : "";
      const pickWhen = (opt.when_to_pick || [])
        .map((item) => `- ${item}`)
        .join("\n") || "- (model did not provide \"when to pick\" conditions)";
      const avoidWhen = (opt.when_not_to_pick || [])
        .map((item) => `- ${item}`)
        .join("\n") || "- (model did not provide \"when NOT to pick\" conditions)";
      const invariants = (opt.required_invariants || [])
        .map((item) => `- ${item}`)
        .join("\n") || "- (no option-specific invariants)";
      const forbidden = (opt.forbidden_topologies || [])
        .map((item) => `- ${item}`)
        .join("\n") || "- (none specified)";
      const evidence = (opt.evidence_citations || []).map((id) => `[${id}]`).join(", ") || "none";
      return `## Option: \`${opt.name}\`${recTag} — ${opt.label}

${opt.summary || ""}

### Pick this when
${pickWhen}

### Avoid when
${avoidWhen}

### Required invariants (when this option is chosen)
${invariants}

### Forbidden topologies (when this option is chosen)
${forbidden}

### Evidence
${evidence}
`;
    })
    .join("\n---\n\n");

  const recommendationBlock = mode === "recommended"
    ? `## Recommendation: \`${recommendation.name}\`

${recommendation.why}

**This recommendation breaks if:**
${(recommendation.when_this_breaks || []).map((item) => `- ${item}`).join("\n") || "- (none specified)"}
`
    : `## No recommendation

The comparison matrix did not show a clear winner. All options above are
viable; the choice depends on team-side constraints that ADR cannot know
(existing infrastructure, hiring plans, vendor relationships, budget
envelope). Pick the option whose "Pick this when" conditions match your
situation, and honor the corresponding block.
`;

  return `# Agent Guardrails: ${spec.decision.title}

${header}

## How to read this file

This file lists **per-option** contracts. The caller (downstream coding
agent or human operator) picks ONE option from the list below, then
honors:

- That option's *Required invariants*
- That option's *Forbidden topologies*

Do NOT mix invariants across options. An invariant tailored to option A
does not apply when the team picks option B.

${recommendationBlock}

${optionBlocks}

## Agentic use (applies to all options)

${allowedAgenticUse.map((item) => `- ${item}`).join("\n") || "- (no agentic constraints carried over from synthesis)"}

Do not replace a chosen option with an easier local implementation path
without producing a superseding ADR.
`;
}

function buildADR(context, spec, knowledgeMap, evidenceItems = []) {
  const mode = spec.decision?.mode || "deferred";
  const rankedOptions = toArray(spec.decision?.ranked_options);
  const recommendation = spec.decision?.recommendation || null;
  const rejected = spec.candidate_topologies.filter(
    (candidate) => candidate.decision === "rejected"
  );

  const headline = mode === "recommended"
    ? `**Recommendation:** \`${recommendation.name}\`. ${rankedOptions.length - 1} other viable option(s) recorded below with their tradeoffs.`
    : mode === "ranked_options"
      ? `**${rankedOptions.length} viable options identified — no single recommendation.** The choice depends on team-side constraints. See tradeoffs below.`
      : `**No viable options yet.** The evidence collected did not produce candidates with sufficient backing.`;

  const optionSections = rankedOptions
    .map((opt, index) => {
      const isRec = recommendation && recommendation.name === opt.name;
      const rank = index + 1;
      const recTag = isRec ? " — *recommended*" : "";
      const summary = opt.summary || "";
      const pickWhen = (opt.when_to_pick || []).map((item) => `- ${item}`).join("\n");
      const avoidWhen = (opt.when_not_to_pick || []).map((item) => `- ${item}`).join("\n");
      const strong = (opt.strong_axes || []).join(", ") || "—";
      const weak = (opt.weak_axes || []).join(", ") || "—";
      const evidence = (opt.evidence_citations || []).map((id) => `[${id}]`).join(", ") || "none";
      return `### Option ${rank}: ${opt.label}${recTag}

${summary}

**Pick this when:**

${pickWhen || "- (model did not provide \"when to pick\" conditions)"}

**Avoid when:**

${avoidWhen || "- (model did not provide \"when NOT to pick\" conditions)"}

**Strong on:** ${strong}
**Weak on:** ${weak}
**Evidence:** ${evidence}`;
    })
    .join("\n\n");

  const recommendationSection = mode === "recommended"
    ? `## Recommendation

**Recommended:** \`${recommendation.name}\`

${recommendation.why}

**This recommendation breaks if:**

${(recommendation.when_this_breaks || []).map((item) => `- ${item}`).join("\n") || "- (none specified)"}
`
    : mode === "ranked_options"
      ? `## Recommendation

**No single recommendation.** All ${rankedOptions.length} options above have genuine tradeoffs that depend on team-side constraints ADR cannot know (existing infrastructure, hiring plans, vendor relationships, budget envelope). Pick the option whose "Pick this when" conditions match your situation.
`
      : `## Recommendation

**No viable options yet.** The evidence collected did not produce candidates with sufficient backing. Re-run with sharper context, or run \`adr supersede\` once more evidence is available.
`;

  return `# ${spec.decision.id}: ${spec.decision.title}

Status: ${titleCase(spec.decision.status)}

${headline}

## Context

Domain: ${context.domain}

Decision focus: ${context.decision}

The Strategic Context Model identified these query shapes:

${context.query_shapes.map((shape) => `- ${shape.name}: ${shape.evidence.join(", ")}`).join("\n")}

The core entities extracted from the brief are:

${context.domain_entities.map((entity) => `- ${entity}`).join("\n") || "- No explicit entities found."}

## Tradeoffs across options

${optionSections || "_(No options were produced by this run.)_"}

${recommendationSection}

## Evidence Acquisition

Promotion rule: ${knowledgeMap.promotion_rule}

Promoted candidates:
${knowledgeMap.promoted_candidates.map((item) => `- ${item.label}: citations ${item.citations.map((id) => `[${id}]`).join(", ")}`).join("\n") || "- No candidate passed promotion gates."}

${(() => {
  const eliminatedByConstraint = toArray(knowledgeMap.insufficient_evidence_candidates).filter(
    (c) => c.promotion_status === "eliminated_by_hard_constraint"
  );
  if (eliminatedByConstraint.length === 0) return "";
  const lines = eliminatedByConstraint
    .map((c) => {
      const failures = toArray(c.constraint_failures)
        .map((f) => `  - **${f.constraint_statement}** — ${f.reason}`)
        .join("\n");
      return `### ${c.label || titleCase(c.name)}\n\nFailed must-have constraints:\n${failures || "  - (no failure detail recorded)"}`;
    })
    .join("\n\n");
  return `## Eliminated by hard constraints

These cleared the evidence promotion gate but failed at least one must_have constraint from \`constraints.json\`. They were removed from the candidate pool before the comparison matrix was built — not included as "weak options" — because the user's stated constraints rule them out structurally. Relax the corresponding constraint and re-run to reconsider.

${lines}
`;
})()}

${rejected.length > 0 ? `## Candidates considered but not surfaced as options

These cleared the evidence promotion gate but the synthesizer did not surface them as a tradeoff-worthy option (often because their axes were too weak to differentiate from one of the kept options, or they failed a critique pass).

${rejected
  .map(
    (candidate) =>
      `### ${candidate.label || titleCase(candidate.name)}\n\n${candidate.fit}\n\nRisks:\n${candidate.risks.map((risk) => `- ${risk}`).join("\n") || "- (none recorded)"}\n\nEvidence: ${candidate.evidence_citations.map((id) => `[${id}]`).join(", ") || "none"}`
  )
  .join("\n\n")}
` : ""}

## Bounded Contexts

${spec.domain_model.bounded_contexts.map((item) => `- ${item}`).join("\n") || "- To be reviewed by the Architect agent."}

${(() => {
  // T3.3: surface private_corpus items the discover stage injected. These
  // are the priors from the user's own repo — patterns + antipatterns
  // tagged with architecture_family that voted in the matrix. Showing
  // them inline so the user can see WHICH of their existing patterns
  // shaped the recommendation, not just that "2 items got injected."
  const privateCorpus = toArray(evidenceItems).filter(
    (item) => item.source_type === "private_corpus"
  );
  if (privateCorpus.length === 0) return "";
  const items = privateCorpus
    .map((item) => {
      const firstClaim = (toArray(item.claims)[0] || {});
      const polarityIcon = firstClaim.polarity === "supports" ? "✓" : firstClaim.polarity === "rejects" ? "✗" : "·";
      return `- ${polarityIcon} [${item.citation_id}] **${item.title}** — ${firstClaim.architecture_family || "unspecified"}: ${firstClaim.claim || item.excerpt.slice(0, 200)} (from ${item.url})`;
    })
    .join("\n");
  return `## Evidence from your repo (discover stage)

The repo scan surfaced these patterns + antipatterns as private-corpus evidence. They voted in the comparison matrix alongside the web research:

${items}
`;
})()}

${(() => {
  // T3.2: ## References section so a reader of ADR.md can resolve [N]
  // citation markers without jumping to citation-audit.json or
  // evidence.json. One bullet per citation_id in citation order, including
  // source_type so the reader can weight credibility at a glance.
  const items = toArray(evidenceItems)
    .filter((item) => Number.isFinite(Number(item.citation_id)))
    .sort((a, b) => Number(a.citation_id) - Number(b.citation_id))
    .map((item) => {
      const title = String(item.title || "(untitled)").trim();
      const url = String(item.url || "").trim();
      const sourceType = String(item.source_type || "unknown");
      const retrieved = item.retrieved_at ? ` · retrieved ${item.retrieved_at}` : "";
      const score = item.score != null ? ` · score ${item.score}` : "";
      return `- [${item.citation_id}] **${title}** — *${sourceType}*${score}${retrieved}${url ? `\n  ${url}` : ""}`;
    })
    .join("\n");
  return items
    ? `## References

${items}
`
    : "";
})()}

## Execution Handoff

ADR stops here. Downstream coding agents or human operators pick one option from the tradeoffs above and consume the matching block in \`agent-guardrails.md\`. Implementation results may feed back as validation evidence, drift evidence, or grounds for a superseding ADR.
`;
}

function buildExecutionHandoff(spec) {
  const mode = spec.decision?.mode || "deferred";
  const rankedOptions = toArray(spec.decision?.ranked_options);
  const recommendation = spec.decision?.recommendation || null;

  return {
    version: VERSION,
    decision_id: spec.decision.id,
    handoff_boundary: "adr_stops_at_execution_handoff",
    mode,
    options: rankedOptions.map((opt) => ({
      name: opt.name,
      label: opt.label,
      summary: opt.summary,
      when_to_pick: opt.when_to_pick || [],
      when_not_to_pick: opt.when_not_to_pick || [],
      required_invariants: opt.required_invariants || [],
      forbidden_topologies: opt.forbidden_topologies || [],
      evidence_citations: opt.evidence_citations || []
    })),
    recommendation,
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
    // Back-compat: mirror the recommended option's invariants when one exists,
    // else empty. New code should read options[] keyed by the picked option.
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
  await appendEvent(outDir, "claim_audit_started", {
    artifact_count: 4
  });
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
  const mode = spec.decision?.mode || "deferred";
  const recommendation = spec.decision?.recommendation || null;
  const rankedOptions = toArray(spec.decision?.ranked_options);

  const decisionLine = mode === "recommended"
    ? `ADR recommends **${recommendation.name}** for **${context.domain}**, alongside ${rankedOptions.length - 1} other viable option(s) recorded with their tradeoffs in \`ADR.md\`.`
    : mode === "ranked_options"
      ? `ADR identified **${rankedOptions.length} viable options** for **${context.domain}**. No single recommendation — see \`ADR.md\` for per-option tradeoffs.`
      : `ADR did not produce viable options for **${context.domain}**. See \`critique.json\` and re-run with sharper context.`;

  return `# Architecture Deep Research Report

## Decision

${decisionLine}

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

// Best-effort variant: if schema validation fails, write the JSON anyway
// (with .invalid suffix) plus a sibling .validation-errors.txt so the user
// can inspect both the data and the failure reason. Returns metadata the
// caller can use to surface the warning in the handoff. Never throws —
// downstream artifact writes must continue regardless.
async function writeJsonBestEffort(filePath, value) {
  try {
    await assertSchemaValid(path.basename(filePath), value);
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
    return { ok: true, path: filePath };
  } catch (error) {
    const errorMsg = String(error?.message || error);
    const invalidPath = filePath.replace(/\.json$/, ".invalid.json");
    const errorsPath = filePath.replace(/\.json$/, ".validation-errors.txt");
    try {
      await writeFile(invalidPath, `${JSON.stringify(value, null, 2)}\n`);
      await writeFile(
        errorsPath,
        `Schema validation failed for ${path.basename(filePath)}.\n\n${errorMsg}\n\nThe data was written to ${path.basename(invalidPath)} for inspection. Fix the data shape or update the schema in docs/schemas/ to clear this warning.\n`
      );
    } catch {
      // Even the fallback write failed — nothing more we can do.
    }
    return {
      ok: false,
      error: errorMsg,
      path: filePath,
      invalid_path: invalidPath,
      errors_path: errorsPath
    };
  }
}

async function research({ inputPath, flags }) {
  return deepResearch({ inputPath, flags });
}

// Loads discovered-principles.json from an outDir if it exists, converts the
// flagged patterns/anti-patterns into private_corpus evidence items, and
// merges them into the live-research evidence pool. Returns the merged pool
// with stable citation_ids assigned across both sources.
async function injectDiscoveredEvidence({ outDir, evidenceItems }) {
  const principlesPath = path.join(outDir, "discovered-principles.json");
  let raw;
  try {
    raw = JSON.parse(await readFile(principlesPath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        evidenceItems,
        syntheticEvidenceItems: [],
        discoveredAntipatterns: [],
        discoveredStack: [],
        injected: false
      };
    }
    throw error;
  }

  // Pick up the discovered stack from discovered-constraints.json (separate
  // file produced by the same discover stage). When present, it drives the
  // `fits_existing_stack` matrix axis so candidates that build on top of the
  // user's existing infra get credit.
  let discoveredStack = [];
  try {
    const constraintsRaw = JSON.parse(
      await readFile(path.join(outDir, "discovered-constraints.json"), "utf8")
    );
    discoveredStack = toArray(constraintsRaw.stack)
      .map((s) => (typeof s === "string" ? s : s?.name || ""))
      .filter(Boolean);
  } catch {
    // Missing / malformed constraints file — proceed without the stack axis.
  }

  // Lazy-import the discover helper to avoid a circular module load.
  const { discoveredEvidenceItems } = await import("./discover/discovered-evidence.mjs");
  const synthetic = discoveredEvidenceItems(raw);
  const merged = assignCitations([...evidenceItems, ...synthetic]);

  return {
    evidenceItems: merged,
    syntheticEvidenceItems: synthetic,
    discoveredAntipatterns: Array.isArray(raw.antipatterns) ? raw.antipatterns : [],
    discoveredPatterns: Array.isArray(raw.patterns) ? raw.patterns : [],
    discoveredStack,
    injected: synthetic.length > 0
  };
}

async function prepareRun({ inputPath, flags, chained = false }) {
  if (!inputPath || !flags.domain || !flags.decision || !flags.out) {
    throw new Error("Usage: adr deep-research <product-context.md> --domain <domain> --decision <decision> --out <dir>");
  }

  const runtime = assertAgenticRuntime(flags);
  const outDir = path.resolve(flags.out);
  let content = await readFile(path.resolve(inputPath), "utf8");

  // `--clarification-answers` lets the caller unblock the clarification gate
  // by passing the answers as text (or a path to a text file). The answers
  // are appended to `content` before strategic-context extraction so any
  // latency / scale / compliance signals land in the matrix. When provided,
  // the gate does not re-block — the caller has explicitly accepted the
  // run with what they supplied.
  const answersFlag = flags["clarification-answers"];
  let clarificationAnswers = null;
  if (typeof answersFlag === "string" && answersFlag.length > 0) {
    let answersText = answersFlag;
    try {
      const resolved = path.resolve(answersFlag);
      const stats = await stat(resolved);
      if (stats.isFile()) {
        answersText = await readFile(resolved, "utf8");
      }
    } catch {
      // Not a file path — treat as inline text.
    }
    if (answersText && answersText.trim().length > 0) {
      clarificationAnswers = answersText.trim();
      content = `${content}\n\n## Clarification answers\n\n${clarificationAnswers}\n`;
    }
  }

  await mkdir(outDir, { recursive: true });
  if (!chained) {
    // Fresh run — truncate events.jsonl and reset cost tracking. When chained
    // from --discover-first, the upstream discover stage already initialized
    // both, and we want to preserve its events on the same log.
    await writeFile(path.join(outDir, "events.jsonl"), "");
    resetLlmCost();
  }
  await appendEvent(outDir, "run_started", {
    command: "deep-research",
    runtime,
    input_path: inputPath,
    domain: flags.domain,
    decision: flags.decision,
    ...(chained ? { chained_from: "discover" } : {}),
    ...(clarificationAnswers ? { clarification_answers_provided: true } : {})
  });

  const context = await buildStrategicContext({
    sourcePath: inputPath,
    content,
    domain: flags.domain,
    decision: flags.decision,
    decisionKind: flags["decision-kind"]
  });
  // assessClarification doesn't know whether the user already provided
  // answers — it just inspects the post-append content. When
  // --clarification-answers was provided, suppress the needs_clarification
  // signal entirely so the second run doesn't emit the same prompt-the-user
  // event that the first run did. The categorical check is also less
  // meaningful after answers were threaded in.
  const rawClarification = assessClarification(context, content);
  const clarification = clarificationAnswers
    ? {
        ...rawClarification,
        needs_clarification: false,
        questions: [],
        action: "Clarification answers were provided on this run; gate suppressed."
      }
    : rawClarification;
  await writeJson(path.join(outDir, "strategic-context.json"), context);
  await writeJson(path.join(outDir, "clarification.json"), clarification);
  await appendEvent(outDir, "strategic_context_created", {
    query_shapes: context.query_shapes.map((shape) => shape.name),
    bounded_contexts: context.bounded_contexts,
    needs_clarification: clarification.needs_clarification
  });

  // Clarification is a hard gate by default. Three ways to satisfy it:
  //   1. Supply enough context in the PRD that no questions are generated.
  //   2. Pass --clarification-answers '<text>' (or a path to a text file).
  //   3. Pass --no-clarify to explicitly accept a lower-confidence run.
  // --strict-clarification is the legacy flag name; accepted as a no-op.
  const optOut = Boolean(flags["no-clarify"]) || Boolean(clarificationAnswers);
  const needsClarification = clarification.needs_clarification && !optOut;

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
    return {
      runtime,
      outDir,
      content,
      context,
      clarification,
      needsClarification,
      constraints: null
    };
  }

  // Hard constraints — extracted ONCE per outDir (file-cached). After this
  // returns, deep-research uses constraints.constraints[].severity to filter
  // the candidate pool. The user can edit constraints.json between runs and
  // the file will be picked up unchanged on re-invocation.
  const constraints = await extractHardConstraints({
    context,
    content,
    outDir,
    flags
  });

  return {
    runtime,
    outDir,
    content,
    context,
    clarification,
    needsClarification,
    constraints
  };
}

// Build research tasks targeting peer products from peers.json (when present).
// Real users picking architectures look at 3-5 similar products to see what
// they did. One task per peer, narrowly scoped to how that peer handles the
// SPECIFIC decision (not their entire architecture). Sources are the peer's
// GitHub repo + docs + engineering blog when known.
async function buildPeerResearchTasks({ context, outDir }) {
  let peersArtifact;
  try {
    peersArtifact = JSON.parse(await readFile(path.join(outDir, "peers.json"), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    return [];
  }
  const peers = toArray(peersArtifact?.peers);
  if (peers.length === 0) return [];

  return peers.map((peer, index) => {
    const sources = [
      peer.github_url,
      peer.docs_url,
      peer.engineering_blog_url,
      peer.homepage_url
    ]
      .map((s) => String(s || "").trim())
      .filter(Boolean);
    const label = peer.label || peer.name;
    return {
      id: `peer_${slugify(peer.name)}_${index + 1}`,
      title: `Peer architecture: how ${label} handles ${context.decision}`,
      objective: `Find evidence of how ${label} (${peer.why_comparable || "a comparable product"}) handles the specific decision aspect: ${context.decision}. Look at their public repo, ARCHITECTURE.md, docs, and engineering blog. Extract their specific choice (e.g. pgvector vs Pinecone, BullMQ vs Trigger.dev) with the citation pointing at the file or URL where they made that choice.`,
      search_queries: [
        `${label} ${context.decision} architecture`,
        `${label} ${context.decision} site:github.com`,
        peer.engineering_blog_url
          ? `${label} ${context.decision} blog`
          : `${label} how they built ${context.decision}`
      ],
      source_targets: sources,
      success_criteria: [
        `Identify the specific ${context.decision} ${label} uses, with a citation to ${peer.github_url || peer.docs_url || "their public docs"}.`,
        `Capture quantitative signals (scale, version, deployment shape) when ${label}'s sources expose them.`
      ],
      peer_target: peer.name
    };
  });
}

async function planResearchPhase({ context, content, outDir, flags }) {
  const plan = await buildResearchPlan(context, content);

  // Peer-targeted tasks land BEFORE the LLM-generated tasks so the bounded
  // slice always preserves at least one task per peer. Without this,
  // max_cycles=1 with many peers could drop most peer tasks.
  const peerTasks = await buildPeerResearchTasks({ context, outDir });
  if (peerTasks.length > 0) {
    await appendEvent(outDir, "peer_research_tasks_added", {
      peer_task_count: peerTasks.length,
      // Concrete content: each task's title, target peer, and the URL
      // it will hit. Lets the user see what's about to happen, not just
      // a count.
      tasks: peerTasks.map((t) => ({
        peer: t.peer_target,
        title: t.title,
        sources: (t.source_targets || []).slice(0, 3)
      }))
    });
  }

  const allTasks = [...peerTasks, ...toArray(plan.tasks)];
  const maxCycles = Number(flags["max-cycles"] || 2);
  const boundedPlan = {
    ...plan,
    max_cycles: maxCycles,
    tasks: allTasks.slice(0, Math.max(1, maxCycles) * MAX_PARALLEL_RESEARCH_AGENTS)
  };
  await writeJson(path.join(outDir, "research-plan.json"), boundedPlan);
  await appendEvent(outDir, "research_plan_created", {
    task_count: boundedPlan.tasks.length,
    peer_task_count: peerTasks.length,
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

// Extract structured hard constraints from the PRD + clarification answers.
//
// Today, "self-hosted only" lands in the PRD as English prose and the
// synthesizer treats it as a soft preference. It should be a structural
// filter — Pinecone (cloud-only) must never appear in ranked_options if the
// user said self-hosted is the deploy model. This stage parses the input
// into structured constraints with severities that the candidate pool can
// be filtered against before the matrix is built.
//
// If constraints.json already exists in outDir (user edited it), it is used
// as-is — no fresh extraction. This is the same "edit-and-re-run" UX as
// pdr.draft.md.
async function extractHardConstraints({ context, content, outDir, flags }) {
  const constraintsPath = path.join(outDir, "constraints.json");
  try {
    const existing = JSON.parse(await readFile(constraintsPath, "utf8"));
    if (existing && Array.isArray(existing.constraints)) {
      await appendEvent(outDir, "constraints_loaded_from_disk", {
        constraint_count: existing.constraints.length,
        must_have_count: existing.constraints.filter((c) => c.severity === "must_have").length
      });
      return existing;
    }
  } catch {
    // File doesn't exist or is corrupt — extract fresh below.
  }

  if (flags && flags["skip-constraint-extraction"]) {
    return { version: VERSION, decision: context.decision, domain: context.domain, constraints: [] };
  }

  let raw;
  try {
    raw = await callLlmJson({
      label: "hard_constraint_extractor",
      system: [
        "You are the hard-constraint extractor for Architecture Deep Research.",
        "",
        `Decision: "${context.decision}" (kind: ${context.decision_kind || "family"})`,
        `Domain: "${context.domain}"`,
        "",
        "Read the user's PRD + clarification answers. Extract constraints that",
        "discriminate candidates — i.e. statements that would let you say 'this",
        "candidate is OUT' if violated. NOT every requirement is a hard",
        "constraint.",
        "",
        "WHAT QUALIFIES AS must_have (eliminates candidates):",
        "  Only structural constraints about HOW the system is deployed or",
        "  WHERE the data lives. These genuinely rule candidates in or out.",
        "    ✓ deployment: 'self-hosted only', 'must run in Docker Compose',",
        "      'no managed services', 'no SaaS'",
        "    ✓ data residency / compliance: 'data must stay in EU', 'SOC2 Type II",
        "      required', 'GDPR right-to-deletion required', 'air-gapped'",
        "    ✓ cost ceiling: 'must run on $X/mo per tenant', 'must be free at",
        "      our scale'",
        "    ✓ infra constraint: 'must integrate with our existing Postgres',",
        "      'no new container processes'",
        "    ✓ region / latency floor: 'p95 < 50ms', 'must serve EU + APAC",
        "      from local regions'",
        "",
        "WHAT DOES NOT QUALIFY AS must_have (these are not constraints, they",
        "are features the chosen candidate must support — they describe the",
        "APPLICATION, not what eliminates candidate options):",
        "    ✗ 'must support agent persistent identities' — this is an app",
        "      requirement; multiple candidates can support it",
        "    ✗ 'must enable human-in-the-loop workflows' — same",
        "    ✗ 'must support multi-tenant filtering' — almost every candidate",
        "      can support this; it doesn't eliminate anyone",
        "    ✗ 'must store embeddings with metadata' — table-stakes for any",
        "      vector store",
        "    ✗ feature lists, capabilities, behaviors of the resulting system",
        "  These either become matrix axes (scored, not filtered) or they're",
        "  implementation details for the chosen candidate. Do NOT extract",
        "  them as constraints at all unless the user said something like",
        "  'cannot use any product that does not support X'.",
        "",
        "Severity ladder:",
        "  - must_have: structural deployment / data / cost / compliance /",
        "    region constraint. Eliminates candidates. Language signals:",
        "    'must', 'only', 'required', 'cannot use', 'no managed', 'no",
        "    SaaS', 'the primary deploy model is'. Be conservative.",
        "  - preferred: explicit preference but not a hard rule. Influences",
        "    scoring, does not filter. Language: 'prefer', 'ideally', 'would",
        "    rather'.",
        "  - nice_to_have: stated interest with no commitment.",
        "",
        "For each constraint, also produce a yes/no check_question that ADR",
        "will ask of each candidate during filtering. Example:",
        "  statement: 'Self-hosted is the primary deploy model.'",
        "  check_question: 'Does <CANDIDATE> support self-hosted deployment?'",
        "",
        "Constraint shape:",
        "  { id (kebab-case slug), statement (the user's words),",
        "    severity, check_question, evidence_from_input (verbatim quote),",
        "    category (deployment / compliance / cost / region / integration / data) }",
        "",
        "Quote evidence_from_input verbatim. Do not invent constraints.",
        "",
        "Cap at 4 must_have constraints. If you find yourself extracting more",
        "than 4, you're probably labeling app-level requirements as must_have —",
        "downgrade most to preferred. Real architectural decisions rarely have",
        "more than 3-4 genuine structural constraints.",
        "",
        "Output JSON: { constraints: [{id, statement, severity, check_question, evidence_from_input, category}] }."
      ].join("\n"),
      user: JSON.stringify({
        domain: context.domain,
        decision: context.decision,
        decision_kind: context.decision_kind || "family",
        prd_content: content.slice(0, 20_000)
      })
    });
  } catch (error) {
    await appendEvent(outDir, "constraints_extraction_failed", {
      error: String(error?.message || error)
    });
    return { version: VERSION, decision: context.decision, domain: context.domain, constraints: [] };
  }

  const constraints = toArray(raw.constraints)
    .map((c, i) => {
      if (!c || typeof c !== "object") return null;
      const severity = String(c.severity || "").trim().toLowerCase();
      if (!["must_have", "preferred", "nice_to_have"].includes(severity)) return null;
      const statement = String(c.statement || "").trim();
      const check = String(c.check_question || "").trim();
      if (!statement || !check) return null;
      return {
        id: slugify(String(c.id || statement).slice(0, 64)) || `constraint_${i + 1}`,
        statement,
        severity,
        check_question: check,
        evidence_from_input: String(c.evidence_from_input || "").trim(),
        category: String(c.category || "").trim()
      };
    })
    .filter(Boolean)
    .slice(0, 8);

  const out = {
    version: VERSION,
    decision: context.decision,
    domain: context.domain,
    extracted_at: nowIso(),
    constraints
  };

  await writeJson(constraintsPath, out);
  await appendEvent(outDir, "constraints_extracted", {
    constraint_count: constraints.length,
    must_have_count: constraints.filter((c) => c.severity === "must_have").length,
    preferred_count: constraints.filter((c) => c.severity === "preferred").length,
    // Concrete content: every constraint with its severity and the
    // verbatim user statement that produced it. This is what makes the
    // filter feel intelligible — "must_have: Self-hosted deployment
    // (from 'self-hosted is the primary deploy model')".
    constraints: constraints.map((c) => ({
      id: c.id,
      severity: c.severity,
      statement: c.statement,
      evidence: String(c.evidence_from_input || "").slice(0, 200)
    }))
  });
  return out;
}

// Filter the promoted-candidate pool against must_have constraints. Each
// (candidate × must_have) pair gets one LLM verdict batched together. A
// candidate that fails ANY must_have is eliminated — not "weak on", out.
// Their evidence stays in the pool (other candidates may still cite it) but
// they no longer appear in promoted_candidates or the comparison matrix.
async function applyConstraintFilter({ context, knowledgeMap, constraints, outDir, flags }) {
  if (flags && flags["skip-constraint-filter"]) {
    return { knowledgeMap, eliminated: [], skipped: true };
  }
  const mustHaves = toArray(constraints?.constraints).filter((c) => c.severity === "must_have");
  const promoted = toArray(knowledgeMap?.promoted_candidates);
  if (mustHaves.length === 0 || promoted.length === 0) {
    return { knowledgeMap, eliminated: [], skipped: false };
  }

  // Batch all (candidate × must_have) pairs into a single LLM call.
  const pairs = [];
  for (const candidate of promoted) {
    for (const constraint of mustHaves) {
      pairs.push({
        candidate_name: candidate.name,
        candidate_label: candidate.label,
        candidate_top_claims: (candidate.support || []).slice(0, 3).map((s) => s.claim),
        candidate_source_types: candidate.source_types,
        constraint_id: constraint.id,
        constraint_statement: constraint.statement,
        constraint_check: constraint.check_question
      });
    }
  }

  let raw;
  try {
    raw = await callLlmJson({
      label: "hard_constraint_filter",
      system: [
        "You are the hard-constraint filter for Architecture Deep Research.",
        "",
        `Decision: "${context.decision}" (kind: ${context.decision_kind || "family"})`,
        "",
        "For each (candidate, must_have_constraint) pair below, answer:",
        "  verdict: 'pass' | 'fail' | 'unsure'",
        "  reason: one short sentence",
        "",
        "Be strict on 'fail' but only when you are confident the candidate",
        "structurally cannot satisfy the constraint. Examples:",
        "  candidate 'Pinecone' + constraint 'self-hosted only' → fail",
        "    (Pinecone is cloud-only — this is not a configuration question)",
        "  candidate 'pgvector' + constraint 'self-hosted only' → pass",
        "    (Postgres extension, runs anywhere Postgres runs)",
        "  candidate 'Weaviate' + constraint 'fits Docker Compose' → unsure",
        "    (technically yes, but requires its own container; might or might",
        "    not match the user's intent)",
        "",
        "'unsure' is KEPT — bias toward keeping when in doubt. Only 'fail'",
        "eliminates the candidate.",
        "",
        "Return EXACTLY one verdict per input pair, keyed by candidate_name",
        "AND constraint_id together. Do not omit, merge, or invent pairs.",
        "",
        "Output JSON: { verdicts: [{candidate_name, constraint_id, verdict, reason}] }."
      ].join("\n"),
      user: JSON.stringify({ pairs })
    });
  } catch (error) {
    await appendEvent(outDir, "constraint_filter_failed", {
      error: String(error?.message || error)
    });
    return { knowledgeMap, eliminated: [], skipped: false };
  }

  // Index verdicts by `${candidate_name}::${constraint_id}` for lookup.
  const verdictIndex = new Map();
  for (const v of toArray(raw.verdicts)) {
    if (!v || typeof v !== "object") continue;
    const name = slugify(String(v.candidate_name || ""));
    const cid = slugify(String(v.constraint_id || ""));
    if (!name || !cid) continue;
    const verdict = String(v.verdict || "").trim().toLowerCase();
    if (!["pass", "fail", "unsure"].includes(verdict)) continue;
    verdictIndex.set(`${name}::${cid}`, { verdict, reason: String(v.reason || "") });
  }

  const eliminated = [];
  const survivors = [];
  for (const candidate of promoted) {
    const slug = slugify(candidate.name);
    const failures = [];
    for (const constraint of mustHaves) {
      const v = verdictIndex.get(`${slug}::${slugify(constraint.id)}`);
      if (v && v.verdict === "fail") {
        failures.push({
          constraint_id: constraint.id,
          constraint_statement: constraint.statement,
          reason: v.reason
        });
      }
    }
    if (failures.length > 0) {
      eliminated.push({ name: candidate.name, label: candidate.label, failures });
    } else {
      survivors.push(candidate);
    }
  }

  // Safety net: if constraint filtering eliminated ALL candidates, the
  // must_have set is too aggressive (typically because the LLM extractor
  // promoted app-level requirements to must_have). Falling through with an
  // empty pool would break the synthesis stage. Instead, abort the filter,
  // keep the original pool, log the issue, and let the synthesis stage see
  // the constraints as scoring inputs only. The user can edit
  // constraints.json to downgrade severities and re-run.
  if (survivors.length === 0) {
    await appendEvent(outDir, "constraint_filter_aborted_empty_pool", {
      must_have_count: mustHaves.length,
      would_have_eliminated: eliminated.map((e) => e.name),
      reason: "Every promoted candidate failed at least one must_have constraint. The constraint set is likely too aggressive — edit constraints.json to downgrade non-deployment-grade constraints to 'preferred', then re-run. Keeping the original pool for this run."
    });
    return { knowledgeMap, eliminated: [], skipped: false, aborted_empty: true };
  }

  if (eliminated.length === 0) {
    await appendEvent(outDir, "constraint_filter_completed", {
      must_have_count: mustHaves.length,
      candidates_kept: survivors.length,
      candidates_eliminated: 0
    });
    return { knowledgeMap, eliminated: [], skipped: false };
  }

  const eliminatedSet = new Set(eliminated.map((e) => slugify(e.name)));
  const movedToEliminated = promoted
    .filter((c) => eliminatedSet.has(slugify(c.name)))
    .map((c) => ({
      ...c,
      promotion_status: "eliminated_by_hard_constraint",
      constraint_failures:
        eliminated.find((e) => slugify(e.name) === slugify(c.name))?.failures || []
    }));

  const updated = {
    ...knowledgeMap,
    promoted_candidates: survivors,
    insufficient_evidence_candidates: [
      ...toArray(knowledgeMap.insufficient_evidence_candidates),
      ...movedToEliminated
    ]
  };

  await appendEvent(outDir, "constraint_filter_completed", {
    must_have_count: mustHaves.length,
    candidates_kept: survivors.length,
    candidates_eliminated: eliminated.length,
    // Concrete content: each eliminated candidate with WHICH constraint
    // it failed and the reason. "Pinecone — failed self-hosted-only
    // (cloud-only managed service)" beats "eliminated 1 candidate".
    eliminated: eliminated.map((e) => ({
      name: e.name,
      label: e.label,
      failures: e.failures.map((f) => ({
        constraint: f.constraint_statement,
        reason: String(f.reason || "").slice(0, 200)
      }))
    })),
    survivors: survivors.map((s) => s.name)
  });

  return { knowledgeMap: updated, eliminated, skipped: false };
}

// Decision-relevance filter on the candidate pool.
//
// The promotion gate keys off evidence_count + source_type. It does not ask
// whether each architecture_family is a plausible ANSWER to the decision
// being made. So a discover phase that tags the project's existing nextjs /
// postgres / rest_api stack as private_corpus evidence contaminates the
// candidate pool when the decision is "auth provider" — nextjs isn't an auth
// provider, but it cleared the gate because it had cited evidence.
//
// One LLM JSON call against all promoted candidates at once. Off-topic
// candidates are demoted out of promoted_candidates (they keep their
// evidence but no longer count as viable options).
async function filterPromotedByRelevance({ context, knowledgeMap, outDir, flags }) {
  if (flags && flags["skip-relevance-filter"]) {
    return { knowledgeMap, dropped: [], skipped: true };
  }
  const promoted = toArray(knowledgeMap?.promoted_candidates);
  if (promoted.length === 0) {
    return { knowledgeMap, dropped: [], skipped: false };
  }

  let raw;
  try {
    raw = await callLlmJson({
      label: "candidate_relevance_filter",
      system: [
        "You are the candidate-relevance filter for Architecture Deep Research.",
        "",
        `The decision being made is: "${context.decision}" (decision_kind: ${context.decision_kind || "family"}).`,
        `Domain: "${context.domain}".`,
        "",
        "You receive a list of architecture-family candidates that cleared the",
        "evidence promotion gate (they have cited support). For each candidate,",
        "decide whether it is a plausible ANSWER to the decision being made.",
        "",
        "Examples of off_topic candidates (drop):",
        "  - decision: 'auth provider', candidate: 'nextjs'    → off_topic (nextjs is a framework, not an auth provider)",
        "  - decision: 'auth provider', candidate: 'postgres_centric_storage'  → off_topic (storage choice, not auth)",
        "  - decision: 'retrieval topology', candidate: 'kubernetes'  → off_topic (compute platform, not retrieval)",
        "",
        "Examples of relevant candidates (keep):",
        "  - decision: 'auth provider', candidate: 'clerk' or 'auth0' or 'token_based_auth'",
        "  - decision: 'retrieval topology', candidate: 'graphrag' or 'vector_rag' or 'hybrid_rag'",
        "",
        "Be strict but not paranoid: if a candidate is a genuine alternative the",
        "decision could land on, keep it. If the candidate is from a different",
        "decision space entirely (the architecture pool contaminated by discover),",
        "drop it.",
        "",
        "Output JSON: { verdicts: [{ name: string, verdict: 'relevant'|'off_topic'|'unsure', reason: string }] }.",
        "",
        "Return EXACTLY one verdict per candidate received. Do not invent new",
        "candidate names. 'unsure' is kept (we bias toward keeping)."
      ].join("\n"),
      user: JSON.stringify({
        decision: context.decision,
        decision_kind: context.decision_kind || "family",
        domain: context.domain,
        candidates: promoted.map((c) => ({
          name: c.name,
          label: c.label,
          evidence_count: c.evidence_count,
          source_types: c.source_types,
          top_claims: (c.support || []).slice(0, 3).map((r) => r.claim)
        }))
      })
    });
  } catch (error) {
    // If the LLM call fails, do NOT drop candidates — bias toward letting
    // through. Log the failure as an event.
    await appendEvent(outDir, "candidate_relevance_filter_failed", {
      error: String(error?.message || error)
    });
    return { knowledgeMap, dropped: [], skipped: false };
  }

  const verdicts = new Map();
  for (const v of toArray(raw.verdicts)) {
    if (!v || typeof v !== "object") continue;
    const name = slugify(String(v.name || ""));
    if (!name) continue;
    const verdict = String(v.verdict || "").trim().toLowerCase();
    if (!["relevant", "off_topic", "unsure"].includes(verdict)) continue;
    verdicts.set(name, { verdict, reason: String(v.reason || "") });
  }

  const dropped = [];
  const keptPromoted = [];
  for (const candidate of promoted) {
    const slug = slugify(candidate.name);
    const v = verdicts.get(slug);
    if (v && v.verdict === "off_topic") {
      dropped.push({ name: candidate.name, reason: v.reason });
      // Move to insufficient_evidence_candidates with an explicit reason.
      continue;
    }
    keptPromoted.push(candidate);
  }

  if (dropped.length === 0) {
    return { knowledgeMap, dropped: [], skipped: false };
  }

  const droppedSet = new Set(dropped.map((d) => slugify(d.name)));
  const movedToInsufficient = promoted
    .filter((c) => droppedSet.has(slugify(c.name)))
    .map((c) => ({
      ...c,
      promotion_status: "off_topic_for_decision",
      off_topic_reason: dropped.find((d) => slugify(d.name) === slugify(c.name))?.reason || ""
    }));

  const updated = {
    ...knowledgeMap,
    promoted_candidates: keptPromoted,
    insufficient_evidence_candidates: [
      ...toArray(knowledgeMap.insufficient_evidence_candidates),
      ...movedToInsufficient
    ]
  };

  await appendEvent(outDir, "candidate_relevance_filter_completed", {
    candidates_kept: keptPromoted.length,
    candidates_dropped: dropped.length,
    dropped_names: dropped.map((d) => d.name)
  });

  return { knowledgeMap: updated, dropped, skipped: false };
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
  flags,
  syntheticEvidenceItems = [],
  discoveredAntipatterns = [],
  discoveredStack = []
}) {
  const initialMatrix = await buildComparisonMatrix({
    context,
    knowledgeMap,
    evidenceItems,
    discoveredAntipatterns,
    discoveredStack
  });
  await writeJson(path.join(outDir, "comparison-matrix.json"), initialMatrix);
  // Concrete content: the strongest cell per candidate so the user sees
  // WHAT made each candidate strong. "pgvector — strong on
  // fits_existing_stack: builds on existing Postgres deployment [12]"
  // beats "matrix: 5×13, 35 empty".
  const cellsByCandidate = new Map();
  for (const cell of toArray(initialMatrix.cells)) {
    if (cell.verdict !== "strong") continue;
    if (!cellsByCandidate.has(cell.candidate)) cellsByCandidate.set(cell.candidate, []);
    cellsByCandidate.get(cell.candidate).push(cell);
  }
  const topCells = [];
  for (const [candidate, cells] of cellsByCandidate.entries()) {
    const top = cells[0]; // first 'strong' cell
    topCells.push({
      candidate,
      axis: top.axis,
      summary: String(top.summary || "").slice(0, 220),
      citations: (top.evidence_citations || []).slice(0, 3)
    });
  }
  await appendEvent(outDir, "comparison_matrix_built", {
    axes: initialMatrix.axes.length,
    candidates: initialMatrix.candidates.length,
    cells: initialMatrix.cells.length,
    empty_cells: initialMatrix.empty_cells.length,
    strong_cells: initialMatrix.cells.filter((c) => c.verdict === "strong").length,
    weak_cells: initialMatrix.cells.filter((c) => c.verdict === "weak").length,
    top_strong_cells: topCells.slice(0, 6)
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
    updatedEvidenceItems = assignCitations([
      ...updatedResearchResults.flatMap((result) => result.evidence),
      ...syntheticEvidenceItems
    ]);
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
      evidenceItems: updatedEvidenceItems,
      discoveredAntipatterns,
      discoveredStack
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
  comparisonMatrix,
  priorCritique = null,
  priorSpec = null
}) {
  return synthesizeArchitectureSpec({
    context,
    knowledgeMap,
    evidenceItems,
    comparisonMatrix,
    priorCritique,
    priorSpec
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
        "",
        "The architecture spec carries a RANKED OPTION SET (decision.ranked_options) and",
        "optionally a recommendation (decision.recommendation). Your job is to critique",
        "the quality of that option set — NOT to pick a different winner.",
        "",
        "Focus on these failure modes:",
        "  1. duplicate_options: two options in ranked_options describe the same thing",
        "     under different names (e.g. token_based_auth + token_based_authentication,",
        "     or two distinct product names that map to the same vendor).",
        "  2. ungrounded_strong_axes: an option claims strong_axes that its citations",
        "     don't actually support. Quote the citation and explain the mismatch.",
        "  3. missing_when_to_pick: an option has empty or generic when_to_pick /",
        "     when_not_to_pick. Tradeoffs without conditions are not tradeoffs.",
        "  4. unsupported_recommendation: mode=\"recommended\" but the comparison matrix",
        "     does not actually show one option dominating. The synthesizer overclaimed.",
        "     If this fires, the right fix is mode=\"ranked_options\" and recommendation=null.",
        "  5. evidence_weakness: an option is backed by single-source or low-quality",
        "     evidence with no official_docs / mature_oss / paper_or_benchmark /",
        "     private_corpus citations.",
        "  6. citation_mismatch: a citation attached to option X actually discusses a",
        "     different option (the bleed pathology — citations 57, 58 are about OAuth",
        "     but appear under token_based_auth).",
        "  7. missing_option: the evidence pool clearly contains a viable option that",
        "     ranked_options omits.",
        "",
        "Severity:",
        "  - high: would mislead a reader (duplicate, ungrounded recommendation, bleed)",
        "  - medium: weakens the document but not load-bearing (thin when_to_pick)",
        "  - low: nice-to-have polish",
        "",
        "Cite evidence by citation_id. Be specific — \"citation 57 mentions OAuth client",
        "credentials, not token-based auth\" beats \"weak citation.\"",
        "",
        "Output JSON: {issues:[{severity, category, description, evidence_citations:[number], target:{kind:'option'|'recommendation'|'spec', name?:string}}], summary:string, recommend_human_review:boolean}.",
        "",
        "Set recommend_human_review:true only when the option set itself is structurally",
        "unreliable — duplicate options, multiple ungrounded recommendations, citation",
        "bleed everywhere. Do NOT set it just because mode=\"ranked_options\" — that's",
        "the correct mode when no winner dominates."
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
    recommend_human_review: critique.recommend_human_review,
    // Concrete content: top 3 high-severity issues with category + the
    // model's actual description. "duplicate_options: token_based_auth
    // and token_based_authentication describe the same thing under
    // different names" beats "7 issues (0 high)".
    top_issues: issues
      .sort((a, b) => {
        const order = { high: 0, medium: 1, low: 2 };
        return (order[a.severity] || 9) - (order[b.severity] || 9);
      })
      .slice(0, 3)
      .map((issue) => ({
        severity: issue.severity,
        category: issue.category,
        description: String(issue.description || "").slice(0, 280),
        citations: (issue.evidence_citations || []).slice(0, 3)
      })),
    summary: String(critique.summary || "").slice(0, 280)
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

  await appendEvent(outDir, "citation_audit_started", {
    evidence_count: evidenceItems.length
  });

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
    await appendEvent(outDir, "citation_audit_batch_started", {
      claim_context: claimContext,
      citation_count: batchPoints.length
    });
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
      const items = toArray(raw.items);
      const verified = items.filter((i) => i.verified).length;
      await appendEvent(outDir, "citation_audit_batch_completed", {
        claim_context: claimContext,
        citation_count: batchPoints.length,
        verified_count: verified,
        unsupported_count: batchPoints.length - verified
      });
      return { claimContext, items };
    } catch (error) {
      await appendEvent(outDir, "citation_audit_batch_completed", {
        claim_context: claimContext,
        citation_count: batchPoints.length,
        verified_count: 0,
        unsupported_count: batchPoints.length,
        error: String(error?.message || error)
      });
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
  // Concrete content: list the unsupported citations so the user sees
  // exactly which sources the verifier rejected. "[57] WorkOS blog —
  // Reason: discusses OAuth2 client credentials, not token-based auth"
  // beats "1 unsupported".
  const unsupportedDetails = toArray(audit.items)
    .filter((i) => !i.verified)
    .slice(0, 5)
    .map((i) => ({
      citation_id: i.citation_id,
      claim_context: i.claim_context,
      reason: String(i.reason || "").slice(0, 200)
    }));
  await appendEvent(outDir, "citation_audit_completed", {
    total_citations: totalCitations,
    verified_count: verifiedCount,
    unsupported_count: unsupportedCount,
    unsupported_details: unsupportedDetails
  });
  return audit;
}

// Drop the recommendation when the critique flagged structural issues. The
// option set itself survives — losing the recommendation just means ADR is
// honest that the evidence doesn't clearly favor one option over another.
// mode goes "recommended" → "ranked_options". When the synthesizer already
// landed at "ranked_options" or "deferred", there's nothing to downgrade.
function dropRecommendation(spec, reason) {
  const mode = spec.decision?.mode || "deferred";
  if (mode !== "recommended") return null;
  const priorRec = spec.decision?.recommendation || null;
  return {
    ...spec,
    decision: {
      ...spec.decision,
      mode: "ranked_options",
      recommendation: null,
      original_recommendation: priorRec,
      original_selected_topology: spec.decision.selected_topology,
      selected_topology: "ranked_options",
      summary: [spec.decision.summary || "", reason].filter(Boolean).join(" ")
    },
    guardrails: {
      ...spec.guardrails,
      // The rolled-up invariants/forbidden_topologies mirrored the
      // recommended option. Without a recommendation, the back-compat
      // fields go empty — callers must read per-option from ranked_options.
      required_invariants: [],
      forbidden_topologies: []
    }
  };
}

function applyCritique({ spec, critique, flags }) {
  if (!critique) return { spec, downgraded: false };
  if (flags["no-enforce-critique"]) return { spec, downgraded: false };
  // Only drop the recommendation when the critique explicitly flagged the
  // option set as structurally unreliable (recommend_human_review === true).
  // High-severity-count alone is not enough — those issues may be polish
  // problems on options the synthesizer correctly identified.
  if (
    critique.high_severity_count === 0 ||
    !critique.recommend_human_review
  ) {
    return { spec, downgraded: false };
  }
  const reason = `Downgraded by critique (${critique.high_severity_count} high-severity issues): ${critique.summary}. Dropped the recommendation; ranked_options preserved.`;
  const downgradedSpec = dropRecommendation(spec, reason);
  if (!downgradedSpec) return { spec, downgraded: false };
  return { spec: downgradedSpec, downgraded: true };
}

function applyCitationAudit({ spec, citationAudit, flags }) {
  if (!citationAudit) return { spec, downgraded: false };
  if (flags["no-enforce-citation-audit"]) return { spec, downgraded: false };
  const recommendation = spec.decision?.recommendation;
  if (!recommendation) return { spec, downgraded: false };

  const recName = slugify(recommendation.name);
  const unsupportedSelected = toArray(citationAudit.items).filter((item) => {
    if (item.verified) return false;
    const context = String(item.claim_context || "");
    return (
      context === "selected_topology_summary" ||
      context.startsWith(`candidate:${recName}:`)
    );
  });
  if (unsupportedSelected.length === 0) return { spec, downgraded: false };

  const reason = `Downgraded by citation audit (${unsupportedSelected.length} unsupported citations on the recommended option). Dropped the recommendation; ranked_options preserved.`;
  const downgradedSpec = dropRecommendation(spec, reason);
  if (!downgradedSpec) return { spec, downgraded: false };
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
  await appendEvent(outDir, "evaluation_pack_started", {
    spec_mode: spec.decision?.mode
  });
  const evaluationPack = await buildEvaluationPack(context, spec, evidenceItems, comparisonMatrix);
  await appendEvent(outDir, "evaluation_pack_completed", {
    test_case_count: evaluationPack.test_cases.length,
    metric_count: Object.keys(evaluationPack.metrics || {}).length
  });
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
  const adrMarkdown = buildADR(context, spec, knowledgeMap, evidenceItems);
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

  await appendEvent(outDir, "handoff_writing", {});
  // Each artifact is written best-effort so one schema validation failure
  // doesn't nuke the rest. ADR.md is the most important reader-facing
  // artifact and MUST be written; the structured JSON files are checked
  // against their schema but a failure falls back to writing .invalid.json
  // + .validation-errors.txt and continues with the next artifact.
  const validationWarnings = [];
  await writeFile(path.join(outDir, "ADR.md"), adrMarkdown);
  const specWrite = await writeJsonBestEffort(path.join(outDir, "architecture.spec.json"), spec);
  if (!specWrite.ok) validationWarnings.push({ file: "architecture.spec.json", error: specWrite.error });
  const evalWrite = await writeJsonBestEffort(path.join(outDir, "domain-evaluation-pack.json"), evaluationPack);
  if (!evalWrite.ok) validationWarnings.push({ file: "domain-evaluation-pack.json", error: evalWrite.error });
  await writeFile(path.join(outDir, "agent-guardrails.md"), buildGuardrails(spec));
  // The handoff is annotated with any validation warnings from earlier
  // writes so the downstream consumer sees them.
  if (validationWarnings.length > 0) {
    handoff = { ...handoff, validation_warnings: validationWarnings };
  }
  const handoffWrite = await writeJsonBestEffort(path.join(outDir, "execution-handoff.json"), handoff);
  if (!handoffWrite.ok) validationWarnings.push({ file: "execution-handoff.json", error: handoffWrite.error });
  await writeFile(path.join(outDir, "research-report.md"), report);
  await writeFile(path.join(outDir, "sources.md"), buildDeepSources(context, evidenceItems));
  if (validationWarnings.length > 0) {
    await appendEvent(outDir, "artifact_validation_warnings", {
      warning_count: validationWarnings.length,
      files: validationWarnings.map((w) => w.file)
    });
  }
  const costSummary = summarizeLlmCost();
  await writeJson(path.join(outDir, "cost.json"), costSummary);
  const mode = spec.decision?.mode || "deferred";
  const recommendation = spec.decision?.recommendation || null;
  const rankedOptions = toArray(spec.decision?.ranked_options);
  await writeJson(path.join(outDir, "state.json"), {
    version: VERSION,
    status: "completed",
    completed_at: nowIso(),
    decision_mode: mode,
    recommendation_name: recommendation ? recommendation.name : null,
    ranked_options_count: rankedOptions.length,
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
    decision_mode: mode,
    recommendation_name: recommendation ? recommendation.name : null,
    ranked_options_count: rankedOptions.length,
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
    mode,
    recommendation,
    rankedOptions,
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
  try {
    return await _deepResearchImpl({ inputPath, flags });
  } catch (error) {
    // Crash-aware state.json. state.json used to lie ({"status":
    // "needs_clarification" from 6 minutes ago}) when deep-research died
    // mid-stage. Now we write a final {"status": "crashed", ...} on every
    // error path so operators can grep state.json instead of events.jsonl
    // to find out what died.
    if (flags && flags.out) {
      try {
        const outDir = path.resolve(flags.out);
        await mkdir(outDir, { recursive: true });
        await writeFile(
          path.join(outDir, "state.json"),
          JSON.stringify(
            {
              version: VERSION,
              status: "crashed",
              completed_at: nowIso(),
              error: String(error?.message || error),
              error_stack: String(error?.stack || "").slice(0, 4000)
            },
            null,
            2
          )
        );
        await appendEvent(outDir, "run_crashed", {
          error: String(error?.message || error)
        });
      } catch {
        // crash-state-write failed too — nothing more we can do
      }
    }
    throw error;
  }
}

async function _deepResearchImpl({ inputPath, flags }) {
  let resolvedInputPath = inputPath;
  let chainedFromDiscover = false;

  if (flags["discover-first"]) {
    if (!flags.out) {
      throw new Error(
        "Usage: adr deep-research --discover-first --repo <path> --domain <d> --decision <d> --out <dir>"
      );
    }
    if (!flags.decision) {
      throw new Error(
        "--discover-first requires --decision <decision>. Example: --decision \"event bus topology\"."
      );
    }
    const outDir = path.resolve(flags.out);
    await mkdir(outDir, { recursive: true });
    // Initialize the shared events.jsonl and cost ledger here, since both
    // discover and the deep-research phases will append to them.
    await writeFile(path.join(outDir, "events.jsonl"), "");
    resetLlmCost();
    const discoverResult = await discoverPatterns({
      flags: {
        repo: flags.repo || ".",
        decision: flags.decision,
        out: outDir,
        "issue-body": flags["issue-body"],
        // Forward peer-finding flags so --discover-first --include-peers
        // actually triggers peers.json generation. Without these, the
        // discover stage's peer-finder never sees the include-peers flag
        // because we hand-built a fresh flags object.
        "include-peers": flags["include-peers"],
        "max-peers": flags["max-peers"],
        seed: flags.seed,
        // Forward decision_kind + domain too so the discover stage can
        // pass them to peer-finder for better peer relevance.
        "decision-kind": flags["decision-kind"],
        domain: flags.domain
      },
      chained: true
    });
    resolvedInputPath = discoverResult.draftPath;
    chainedFromDiscover = true;
    // discover_completed already fired with these payload fields — no need
    // for a second event saying the same thing.
  }

  const prepared = await prepareRun({
    inputPath: resolvedInputPath,
    flags,
    chained: chainedFromDiscover
  });
  if (prepared.needsClarification) {
    const questions = prepared.clarification.questions || [];
    console.log("");
    console.log("Clarification needed before deep-research can run:");
    console.log("");
    questions.forEach((q, i) => {
      console.log(`  ${i + 1}. ${q}`);
    });
    console.log("");
    console.log("Two ways to unblock:");
    console.log("  - Re-run with --clarification-answers '<text>'   (answers as text or a path to a file)");
    console.log(`  - Edit ${path.resolve(resolvedInputPath)} to address the questions, then re-run`);
    console.log("");
    console.log("To skip the gate entirely: pass --no-clarify (you accept a lower-confidence run).");
    console.log(`Full questions also written to ${path.join(prepared.outDir, "clarification.json")}`);
    return {
      status: "needs_clarification",
      out_dir: prepared.outDir,
      questions
    };
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

  // If a `discovered-principles.json` is already in the outDir (either because
  // the operator ran `adr discover` first or because --discover-first ran it
  // a moment ago), merge the team's private_corpus evidence into the pool
  // before the comparison matrix is built. This is what lets a candidate that
  // conflicts with a team antipattern land a `weak` verdict on its dedicated
  // axis with the team's own citation backing it.
  const discoveredInjection = await injectDiscoveredEvidence({
    outDir: prepared.outDir,
    evidenceItems
  });
  let syntheticEvidenceItems = discoveredInjection.syntheticEvidenceItems;
  const discoveredAntipatterns = discoveredInjection.discoveredAntipatterns;
  const discoveredStack = toArray(discoveredInjection.discoveredStack);
  if (discoveredInjection.injected) {
    evidenceItems = discoveredInjection.evidenceItems;
    knowledgeMap = buildKnowledgeMap(evidenceItems);
    await writeJson(path.join(prepared.outDir, "evidence.json"), evidenceItems);
    await writeJson(path.join(prepared.outDir, "knowledge-map.json"), knowledgeMap);
    await appendEvent(prepared.outDir, "private_corpus_evidence_injected", {
      synthetic_count: syntheticEvidenceItems.length,
      new_evidence_total: evidenceItems.length,
      promoted_candidate_count: knowledgeMap.promoted_candidates.length,
      antipattern_axis_count: discoveredAntipatterns.length
    });
  }

  // Hard-constraint filter — must_have constraints eliminate candidates
  // structurally, not by adding a "weak" cell. "Self-hosted only" drops
  // Pinecone before the matrix ever sees it. Eliminated candidates move to
  // insufficient_evidence_candidates tagged eliminated_by_hard_constraint
  // with the failed constraint(s) attached.
  const constraintResult = await applyConstraintFilter({
    context: prepared.context,
    knowledgeMap,
    constraints: prepared.constraints,
    outDir: prepared.outDir,
    flags
  });
  if (constraintResult.eliminated.length > 0) {
    knowledgeMap = constraintResult.knowledgeMap;
    await writeJson(path.join(prepared.outDir, "knowledge-map.json"), knowledgeMap);
  }

  // Decision-relevance filter on the candidate pool — drop families that
  // cleared the evidence gate but are not plausible answers to the decision.
  // This catches the discover-phase contamination class of bug (nextjs ends
  // up in the auth-provider candidate pool because the repo uses Next.js).
  const relevanceResult = await filterPromotedByRelevance({
    context: prepared.context,
    knowledgeMap,
    outDir: prepared.outDir,
    flags
  });
  if (relevanceResult.dropped.length > 0) {
    knowledgeMap = relevanceResult.knowledgeMap;
    await writeJson(path.join(prepared.outDir, "knowledge-map.json"), knowledgeMap);
  }

  let comparisonMatrix = null;
  let adversarialCycles = 0;
  if (!flags["skip-comparison-matrix"]) {
    const compareResult = await compareTopologiesPhase({
      context: prepared.context,
      knowledgeMap,
      evidenceItems,
      researchResults,
      outDir: prepared.outDir,
      flags,
      syntheticEvidenceItems,
      discoveredAntipatterns,
      discoveredStack
    });
    comparisonMatrix = compareResult.comparisonMatrix;
    researchResults = compareResult.researchResults;
    evidenceItems = compareResult.evidenceItems;
    knowledgeMap = compareResult.knowledgeMap;
    adversarialCycles = compareResult.adversarialCycles;
  }

  await appendEvent(prepared.outDir, "synthesis_started", {
    promoted_candidates: knowledgeMap.promoted_candidates.length,
    evidence_count: evidenceItems.length
  });
  let rawSpec = await synthesizeDecisionPhase({
    context: prepared.context,
    knowledgeMap,
    evidenceItems,
    comparisonMatrix
  });
  // Concrete content: each ranked option with its name, label, 1-line
  // summary, top strong + weak axes, and pick-this-when condition. Plus
  // the recommendation's full "why" reasoning when there is one. This is
  // the moment the user finds out what ADR decided.
  const synthOptions = toArray(rawSpec.decision?.ranked_options).map((o) => ({
    name: o.name,
    label: o.label,
    summary: String(o.summary || "").slice(0, 200),
    strong_axes: toArray(o.strong_axes).slice(0, 4),
    weak_axes: toArray(o.weak_axes).slice(0, 4),
    when_to_pick: toArray(o.when_to_pick).slice(0, 2).map((s) => String(s).slice(0, 160))
  }));
  await appendEvent(prepared.outDir, "synthesis_completed", {
    mode: rawSpec.decision?.mode,
    ranked_options_count: synthOptions.length,
    has_recommendation: Boolean(rawSpec.decision?.recommendation),
    recommendation_name: rawSpec.decision?.recommendation?.name || null,
    recommendation_why: rawSpec.decision?.recommendation?.why
      ? String(rawSpec.decision.recommendation.why).slice(0, 360)
      : null,
    options: synthOptions
  });

  await appendEvent(prepared.outDir, "critique_started", {
    spec_mode: rawSpec.decision?.mode
  });
  let critique = flags["skip-critique"]
    ? null
    : await critiqueDecisionPhase({
        context: prepared.context,
        spec: rawSpec,
        knowledgeMap,
        evidenceItems,
        outDir: prepared.outDir
      });

  // Re-synthesis loop: when the critique surfaces high-severity issues with
  // the first synthesis, give the synthesizer one chance to fix them. The
  // critique already names what's wrong (citations pointing at the wrong
  // candidate, duplicate candidates, selected topology not backed by
  // promoted candidates). Without this loop the pipeline diagnoses its own
  // failure and proceeds anyway — exactly the pathology this ship exists
  // to fix.
  //
  // ~1 extra synthesis call + 1 extra critique call. Cheap relative to the
  // 60+ extractor calls that produced the underlying evidence.
  const wantResynth =
    critique &&
    critique.high_severity_count > 0 &&
    !flags["skip-resynthesis"];
  if (wantResynth) {
    await appendEvent(prepared.outDir, "resynthesis_started", {
      original_high_severity_count: critique.high_severity_count,
      original_selected_topology: rawSpec.decision?.selected_topology
    });
    const resynthSpec = await synthesizeDecisionPhase({
      context: prepared.context,
      knowledgeMap,
      evidenceItems,
      comparisonMatrix,
      priorCritique: critique,
      priorSpec: rawSpec
    });
    // Persist the v1 spec + critique for transparency; the active spec
    // (whichever wins) keeps the canonical filename.
    await writeJson(path.join(prepared.outDir, "architecture.spec.v1.json"), rawSpec);
    await writeJson(path.join(prepared.outDir, "critique.v1.json"), critique);
    await writeJson(path.join(prepared.outDir, "architecture.spec.v2.json"), resynthSpec);

    const resynthCritique = await critiqueDecisionPhase({
      context: prepared.context,
      spec: resynthSpec,
      knowledgeMap,
      evidenceItems,
      outDir: prepared.outDir
    });

    if (resynthCritique.high_severity_count < critique.high_severity_count) {
      rawSpec = resynthSpec;
      critique = resynthCritique;
      await appendEvent(prepared.outDir, "resynthesis_accepted", {
        new_high_severity_count: resynthCritique.high_severity_count,
        new_selected_topology: resynthSpec.decision?.selected_topology
      });
    } else {
      await appendEvent(prepared.outDir, "resynthesis_rejected", {
        new_high_severity_count: resynthCritique.high_severity_count,
        reason:
          resynthCritique.high_severity_count > critique.high_severity_count
            ? "new_synthesis_introduced_more_issues"
            : "no_improvement"
      });
    }
  }

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
  if (result.mode === "recommended") {
    console.log(
      `Recommendation: ${result.recommendation.name} (one of ${result.rankedOptions.length} viable options)`
    );
  } else if (result.mode === "ranked_options") {
    console.log(
      `Ranked options: ${result.rankedOptions.length} viable options, no single recommendation`
    );
    console.log(
      `  ${result.rankedOptions.map((o) => o.name).join(" · ")}`
    );
  } else {
    console.log("No viable options produced — see critique.json and re-run with sharper context.");
  }
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

  return {
    status: "completed",
    out_dir: prepared.outDir,
    selected_topology: result.selectedTopology
  };
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

  const drResult = await deepResearch({ inputPath: nextInputPath, flags });
  if (drResult && drResult.status === "needs_clarification") {
    return drResult;
  }

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

// `discoverPatterns` lives in src/discover/index.mjs. It is re-exported here
// so framework adapters and the CLI can import it from the same module as
// every other phase. We import it lazily inside a wrapper to avoid a circular
// import at module load: src/discover/* imports back into this kernel for
// callLlmJson, appendEvent, writeJson, etc.
async function discoverPatterns(input) {
  const mod = await import("./discover/index.mjs");
  return mod.discoverPatterns(input);
}

export {
  VERSION,
  inferDecisionKind,
  applyCitationAudit,
  activeLlmProvider,
  activeSearchProviders,
  appendEvent,
  applyCritique,
  assessClarification,
  buildAdaptiveResearchPlan,
  buildAdversarialResearchPlan,
  buildComparisonMatrix,
  buildEvaluationPack,
  buildExecutionHandoff,
  buildGuardrails,
  buildKnowledgeMap,
  buildResearchPlan,
  buildStrategicContext,
  callLlmJson,
  classifySource,
  compareTopologiesPhase,
  critiqueDecisionPhase,
  deepResearch,
  deriveComparisonAxes,
  digestPaper,
  discoverPatterns,
  executeResearchPhase,
  applyConstraintFilter,
  extractClaims,
  extractHardConstraints,
  filterPromotedByRelevance,
  openUrl,
  getLlmJsonProvider,
  githubApi,
  injectDiscoveredEvidence,
  inspectGithubRepo,
  isGithubRepoUrl,
  isPaperUrl,
  nowIso,
  parseGithubRepoUrl,
  planResearchPhase,
  prepareRun,
  research,
  resetLlmCost,
  runResearchAgents,
  searchWithProvider,
  setLlmJsonProvider,
  summarizeLlmCost,
  supersedeAdr,
  synthesizeDecisionPhase,
  verifyCitationsPhase,
  writeJson,
  writeRunArtifacts
};
