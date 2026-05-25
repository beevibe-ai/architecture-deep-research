import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const VERSION = "0.3.0";
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

// Lightweight Mermaid validator for LLM-emitted flowchart source. Catches the
// common breakage modes — empty output, triple-backtick contamination from the
// LLM wrapping its own answer, missing `flowchart <dir>` header, and unbalanced
// node-shape delimiters that would crash the GitHub/Obsidian renderer. Returns
// { ok: true } or { ok: false, error: <reason> }. We drop the diagram on
// failure rather than blocking the rest of the report (see synthesizeResearchReport).
function validateMermaidSource(source) {
  if (typeof source !== "string") return { ok: false, error: "not a string" };
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, error: "empty" };
  if (trimmed.includes("```")) return { ok: false, error: "contains triple-backticks (LLM wrapped its own answer)" };
  if (!/^flowchart\s+(LR|TD|TB|RL|BT)\b/i.test(trimmed)) {
    return { ok: false, error: "must start with 'flowchart <LR|TD|TB|RL|BT>'" };
  }
  const pairs = [
    ["[", "]"],
    ["(", ")"],
    ["{", "}"]
  ];
  for (const [open, close] of pairs) {
    const opens = (trimmed.match(new RegExp(`\\${open}`, "g")) || []).length;
    const closes = (trimmed.match(new RegExp(`\\${close}`, "g")) || []).length;
    if (opens !== closes) {
      return { ok: false, error: `unbalanced ${open}${close}: ${opens} open vs ${closes} close` };
    }
  }
  return { ok: true };
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

async function buildStrategicContext({ sourcePath, content, domain, decision }) {
  const raw = await callLlmJson({
    label: "strategic_context_extractor",
    system: [
      "You are the strategic context extractor for Architecture Deep Research.",
      "Read the product context document and extract the architectural shape grounded in what the document actually says.",
      "Do not invent entities, contexts, or constraints that are not supported by the text.",
      "Leave a field empty (empty array, or the string \"not_specified\" for operational envelope fields) rather than inferring from prior knowledge of similar domains.",
      "",
      "You are mapping the option space across all directions — topology, vendor, deployment, integration. Do not narrow prematurely.",
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
        ? "These gaps are recorded as decision context notes; the run continues. Edit the PRD and re-run if you want them folded into the analysis."
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
  "research-report.json": "../docs/schemas/research-report.schema.json",
  "claim-audit.json": "../docs/schemas/claim-audit.schema.json",
  "citation-audit.json": "../docs/schemas/citation-audit.schema.json",
  "clarification.json": "../docs/schemas/clarification.schema.json",
  "decision-context.json": "../docs/schemas/decision-context.schema.json",
  "comparison-matrix.json": "../docs/schemas/comparison-matrix.schema.json",
  "critique.json": "../docs/schemas/critique.schema.json",
  "discovered-constraints.json": "../docs/schemas/discovered-constraints.schema.json",
  "discovered-principles.json": "../docs/schemas/discovered-principles.schema.json",
  "domain-evaluation-pack.json": "../docs/schemas/domain-evaluation-pack.schema.json",
  "evidence.json": "../docs/schemas/evidence.schema.json",
  "execution-handoff.json": "../docs/schemas/execution-handoff.schema.json",
  "follow-up-questions.json": "../docs/schemas/follow-up-questions.schema.json",
  "knowledge-map.json": "../docs/schemas/knowledge-map.schema.json",
  "peers.json": "../docs/schemas/peers.schema.json",
  "principles.json": "../docs/schemas/principles.schema.json",
  "principles-health.json": "../docs/schemas/principles-health.schema.json",
  "principle-stats.json": "../docs/schemas/principle-stats.schema.json",
  "research-plan.json": "../docs/schemas/research-plan.schema.json",
  "review.json": "../docs/schemas/review-violations.schema.json",
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
  // Re-synthesis loop writes research-report.v1.json (the original) and
  // research-report.v2.json (the post-critique re-synthesis). Both are
  // research-report shapes. Same for critique.v1.json / critique.v2.json.
  if (/^research-report\.v\d+\.json$/.test(filename)) {
    return "research-report.json";
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

// Rough cost estimate before research runs. Empirical values from a few
// dozen sample runs against the openai-compatible / gpt-4.1-mini backend.
// Reality varies ±30% depending on PRD size, source page length, and how
// many cycles the adaptive/adversarial loops trigger. Good enough for
// budget sanity-checking.
const COST_PROFILE_USD = {
  base_overhead: 0.020,        // planner + matrix + synthesis + critique + audits + handoff
  per_research_task: 0.012,    // search + ~5 sources × (extractClaims + judge)
  per_peer_task: 0.012,        // same shape as research_task
  per_adversarial_task: 0.010,
  per_resynthesis: 0.015,      // conditional, fires when critique high-severity
  per_discover: 0.010          // discover_first add-on
};

function estimateRunCostUsd({ task_count = 6, peer_task_count = 0, include_discover = false, include_peers = false } = {}) {
  let total = COST_PROFILE_USD.base_overhead;
  total += task_count * COST_PROFILE_USD.per_research_task;
  total += peer_task_count * COST_PROFILE_USD.per_peer_task;
  total += task_count * 0.5 * COST_PROFILE_USD.per_adversarial_task; // not every task gets adversarial
  if (include_discover) total += COST_PROFILE_USD.per_discover;
  // Re-synthesis fires ~30% of runs (when critique flags high-severity).
  total += 0.3 * COST_PROFILE_USD.per_resynthesis;
  // peer-finding LLM call when --include-peers is on
  if (include_peers) total += 0.005;
  return Number(total.toFixed(4));
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
    signal: AbortSignal.timeout(Number(process.env.ADR_LLM_TIMEOUT_MS || 300_000))
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
      "",
      "You are mapping the option space across all directions — topology, vendor, deployment, integration. Do not narrow prematurely.",
      "Generate tasks that span the full space: patterns and topologies AND named products / vendors / libraries where applicable, deployment modes (self-hosted vs managed), and integration paths. Search queries should include both pattern names and specific product names when both are plausible. source_targets should include vendor docs, comparison writeups, engineering blogs, benchmarks, and postmortems.",
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

// Community-discussion platforms — Reddit, HN, Twitter/X, Stack Exchange.
// These aren't general web: they're community signal weighted by engagement
// (upvotes, scores). Adoption-strategy peers depend on these for evidence
// because their architecture isn't publicly documented but their adoption
// stories are. Synthesis frames their claims as practitioner signal, not as
// hard architectural facts.
function classifyCommunityPlatform(url) {
  if (!url) return null;
  if (/(^|\/\/|\.)reddit\.com\//i.test(url)) return "reddit";
  if (/(^|\/\/)news\.ycombinator\.com\//i.test(url)) return "hackernews";
  if (/(^|\/\/|\.)(twitter\.com|x\.com)\//i.test(url)) return "twitter";
  if (/(^|\/\/|\.)(stackoverflow\.com|stackexchange\.com)\//i.test(url)) return "stackexchange";
  return null;
}

// Extract a community sub-platform identifier — subreddit for reddit, HN
// story id for an /item?id=N link. Returned alongside `platform` so the
// auditor and synthesis can refer to the specific thread the citation came
// from. Best-effort; missing details are returned as undefined.
function extractCommunityPlatformDetails(url, platform) {
  const out = {};
  if (!url) return out;
  if (platform === "reddit") {
    const m = String(url).match(/\/r\/([A-Za-z0-9_]+)/);
    if (m) out.subreddit = m[1];
  } else if (platform === "hackernews") {
    const m = String(url).match(/[?&]id=(\d+)/);
    if (m) out.story_id = m[1];
  }
  return out;
}

function classifySource(url) {
  if (!url) return "unknown";
  if (/^mcp:\/\//i.test(url)) return "private_corpus";
  if (classifyCommunityPlatform(url)) return "community_discussion";
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
    // community_discussion keeps general_web's weight for now (these URLs
    // previously fell through to general_web). The class exists so synthesis
    // and the auditor can treat them differently; scoring is a separate
    // follow-up.
    community_discussion: 0.45,
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

// Softer match for community-discussion sources where the quote is a
// paraphrased summary of a discussion thread, not a literal substring.
// Returns true when ≥ 60% of significant (≥4-char) tokens from the quote
// appear in the excerpt. Picks the simpler ratio match over a full
// semantic check — community-source claims still surface in synthesis,
// just framed as practitioner signal rather than hard fact.
function communityQuoteMatches(quote, excerpt) {
  const tokens = normalizeForQuoteCheck(quote)
    .split(/\W+/)
    .filter((t) => t.length >= 4);
  if (tokens.length === 0) return false;
  const haystack = normalizeForQuoteCheck(excerpt);
  const hits = tokens.filter((t) => haystack.includes(t)).length;
  return hits / tokens.length >= 0.6;
}

async function extractClaims({ context, task, source }) {
  const result = await callLlmJson({
    label: "source_claim_extractor",
    system: [
      "You extract architecture-decision evidence from sources for the decision focus:",
      `  domain:   "${context.domain}"`,
      `  decision: "${context.decision}"`,
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
      "ARCHITECTURE FAMILY — name the candidate this claim is about:",
      "architecture_family names the candidate the claim discusses — either a",
      "MACRO-level architectural family OR a specific named product / vendor /",
      "library when the source talks about one. Roll up low-level concepts under",
      "their parent macro family. Examples:",
      "- 'Leiden Community Detection', 'Hierarchical Clustering'",
      "  → architecture_family: 'GraphRAG'",
      "- 'Top-K Vector Search', 'HNSW Index', 'BM25 Reranker'",
      "  → architecture_family: 'Vector RAG'",
      "- 'ReAct Tool Use', 'Orchestrator-Worker'",
      "  → architecture_family: 'Agentic Retrieval'",
      "- Specific products are first-class: 'Clerk', 'Auth0', 'WorkOS', 'BullMQ', 'pgvector', 'Pinecone'.",
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
  const isCommunitySource = source.source_type === "community_discussion";

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
      if (!claim.quote || claim.quote.length < 10) return false;
      // Community-discussion sources (Reddit, HN, Twitter, Stack Exchange)
      // get a softer rule: the quote may be a paraphrased summary of a
      // discussion thread, not a literal substring. We still confirm the
      // quote captures the gist via a token-ratio match — see
      // communityQuoteMatches — but we don't demand verbatim text.
      if (isCommunitySource) {
        return communityQuoteMatches(claim.quote, source.excerpt);
      }
      // Architecture / docs / OSS sources keep the literal-substring rule.
      // It's the grounding gate that forces the extractor to admit when a
      // source does not actually support a claim. Hallucinated quotes are
      // dropped.
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

    // Tag community-discussion sources with their platform + sub-identifier
    // (subreddit for reddit, story_id for HN). The auditor and synthesis
    // both branch on source_type === "community_discussion"; the
    // community_meta object lets downstream code reference the specific
    // thread the citation came from.
    const communityPlatform =
      source_type === "community_discussion" ? classifyCommunityPlatform(result.url) : null;
    const communityMeta = communityPlatform
      ? { platform: communityPlatform, ...extractCommunityPlatformDetails(result.url, communityPlatform) }
      : null;

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
      ...(communityMeta ? { community_meta: communityMeta } : {}),
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

function buildKnowledgeMap(evidenceItems, { offTopicNames = new Set() } = {}) {
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

  // ADR is a research-report engine. Every family with at least one evidence
  // claim shows up as a candidate in the report. The off-topic filter still
  // drops families that aren't in the option space at all (e.g. a framework
  // name in an auth-provider decision), but evidence-depth is NOT a filter —
  // a "thin" candidate gets its own section with the thin-evidence label so
  // the reader can weight it.
  const patterns = [...families.values()].map((item) => {
    const sourceTypes = [...item.source_types];
    const evidenceCount = item.support.length + item.warnings.length + item.rejections.length;
    const isOffTopic = offTopicNames.has(item.name);
    let evidenceDepth;
    if (evidenceCount >= 5) evidenceDepth = "thick";
    else if (evidenceCount >= 2) evidenceDepth = "medium";
    else evidenceDepth = "thin";

    return {
      name: item.name,
      label: item.label,
      evidence_depth: evidenceDepth,
      evidence_count: evidenceCount,
      source_types: sourceTypes,
      citations: [...item.citations].sort((a, b) => a - b),
      support: item.support,
      warnings: item.warnings,
      rejections: item.rejections,
      score: Number(finiteNumber(item.score_total, 0).toFixed(3)),
      ...(isOffTopic ? { off_topic_for_decision: true } : {})
    };
  });

  const candidates = patterns
    .filter((item) => !item.off_topic_for_decision)
    .sort((a, b) => b.score - a.score);
  const offTopicCandidates = patterns.filter((item) => item.off_topic_for_decision);

  return {
    version: VERSION,
    acquisition_mode: "evidence_only_live_research",
    acquisition_rule:
      "Architecture families are extracted from the live evidence pool. Each candidate's depth (thick / medium / thin) reflects how much corroborating evidence was found. The reader decides how much weight to give each section.",
    candidates,
    off_topic_candidates: offTopicCandidates
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

  // Adoption-mode axes: only added when the evidence pool actually contains
  // at least one community_discussion source. Architecture-mode runs (no
  // adoption peers) skip these — otherwise pure-architecture matrices fill
  // up with empty cells the synthesis has no evidence to score against.
  const hasCommunityEvidence = toArray(options.evidenceItems).some(
    (item) => item && item.source_type === "community_discussion"
  );
  if (hasCommunityEvidence) {
    axes.push({
      id: "ecosystem_traction",
      label: "Ecosystem traction",
      rationale:
        "Community size + plugin/extension count, scored from community_discussion evidence."
    });
    axes.push({
      id: "integration_breadth",
      label: "Integration breadth",
      rationale:
        "How many integrations or how broadly the option is adopted across the practitioner community."
    });
    axes.push({
      id: "practitioner_pain_points",
      label: "Practitioner pain points",
      rationale:
        "What users actually complain about in community threads. Scored from community_discussion evidence."
    });
  }

  return axes;
}

function candidatesFromKnowledgeMap(knowledgeMap) {
  const candidates = toArray(knowledgeMap?.candidates).map((item) => ({
    name: item.name,
    label: item.label,
    evidence_depth: item.evidence_depth || "thin",
    evidence_count: item.evidence_count,
    score: finiteNumber(item.score, 0),
    citations: item.citations
  }));
  const seen = new Set();
  const merged = [];
  for (const candidate of candidates) {
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
        evidence_depth: candidate.evidence_depth,
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
  const axes = deriveComparisonAxes(context, {
    discoveredAntipatterns,
    discoveredStack,
    evidenceItems
  });
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

  const promotedCandidates = toArray(matrix.candidates);
  const promotedNames = promotedCandidates.map((c) => c.name);

  // Round-robin balance: every candidate gets EXACTLY one adversarial task.
  // This stops the "Milvus looks clean by absence of adversarial probing"
  // failure mode. The LLM is told the exact target distribution; post-
  // processing enforces it by padding any candidate the LLM skipped with a
  // generic per-candidate fallback probe.
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
        evidence_depth: candidate.evidence_depth
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

async function synthesizeResearchReport({
  context,
  knowledgeMap,
  evidenceItems,
  comparisonMatrix,
  priorCritique = null,
  priorSpec = null,
  outDir = null
}) {
  const candidateRecords = toArray(knowledgeMap?.candidates);
  const candidateNames = candidateRecords.map((c) => c.name);
  const candidateSet = new Set(candidateNames);
  const depthByName = new Map(
    candidateRecords.map((c) => [c.name, c.evidence_depth || "thin"])
  );

  const decisionContextNotes = toArray(context.decision_context_notes);

  const isResynth = Boolean(priorCritique && priorSpec);
  const result = await callLlmJson({
    label: isResynth ? "research_report_agent_resynth" : "research_report_agent",
    system: [
      "You are the Architecture Deep Research research-report agent.",
      "",
      "Your job is to write a RESEARCH REPORT on the architectural decision",
      "space. You do NOT pick a winner. You do NOT produce a recommendation.",
      "The decision is the reader's; your job is to give them enough cited",
      "context to decide well.",
      "",
      "This is the same posture as OpenAI Deep Research, Perplexity Deep",
      "Research, and Gemini Deep Research — map the space, cite the sources,",
      "surface the tradeoffs. Do not collapse to one answer.",
      "",
      "PRIMARY OUTPUT — a research report covering EVERY candidate.",
      "",
      "Every candidate from the knowledge_map.candidates list MUST get its own",
      `options[] entry. Do NOT drop candidates. Do NOT filter further. List: [${candidateNames.map((n) => `"${n}"`).join(", ")}].`,
      "",
      "Each option entry shape:",
      "  {",
      "    name,                       // canonical id, must appear in the candidates list above",
      "    label,                      // human-readable title",
      "    summary,                    // 2-3 sentences, what this candidate is",
      "    evidence_depth,             // \"thick\" | \"medium\" | \"thin\" — copy from knowledge_map",
      "    what_evidence_shows,        // 1-2 paragraphs: what the cited claims actually say",
      "    what_evidence_does_not_show,// 1 paragraph: known gaps (no production scale, no cost numbers, no failure-mode write-ups, etc.)",
      "    strong_axes,                // axis ids where the matrix marks this candidate strong",
      "    weak_axes,                  // axis ids where the matrix marks this candidate weak",
      "    when_to_pick,               // 2-4 evidence-summarized reading aids: situations the cited evidence supports for this candidate",
      "    when_not_to_pick,           // 2-4 evidence-summarized reading aids: situations the cited evidence contraindicates",
      "    citations                   // citation_ids supporting this candidate",
      "  }",
      "",
      "when_to_pick and when_not_to_pick are READING AIDS, not recommendations.",
      "They tell the reader which situations the cited evidence actually",
      "supports or contraindicates for that option — they do not tell the",
      "reader what to do.",
      "",
      "TOP-LEVEL FIELDS:",
      "  executive_summary: 2-3 paragraphs. What's in the space, what's at",
      "                     stake, what to watch for as the reader weighs",
      "                     candidates. Cite where it helps.",
      "  option_space_shape: 1 paragraph. Cross-cutting observations about the",
      "                      family of candidates (e.g. \"graph-store products",
      "                      split along self-hosted vs managed, with",
      "                      mature_oss leaders in both\").",
      "  cross_cutting_tradeoffs: axes where candidates split. For EACH",
      "                            comparison-matrix axis that shows real",
      "                            variance across candidates, write one entry:",
      "    { axis, observation, candidates_high: [name], candidates_low: [name] }",
      "  open_questions: 3-8 free-form items the evidence pool did NOT resolve.",
      "                  Draw from matrix axes with mostly empty cells, candidates",
      "                  with \"thin\" depth, claims sourced from low-confidence",
      "                  sources (general_web without corroboration).",
      "",
      "FORBIDDEN:",
      "- Do not produce a \"Recommendation\" section.",
      "- Do not crown a winner in executive_summary or option_space_shape.",
      "- Do not filter candidates below the off-topic level — every candidate",
      "  in knowledge_map.candidates gets a section.",
      "- Do not invent candidates. options[].name must appear in the list above.",
      "",
      decisionContextNotes.length > 0
        ? `Decision context notes from the user (annotations, NOT filters): ${decisionContextNotes.map((n) => `"${n.statement || ""}"`).slice(0, 8).join("; ")}. Reflect these in when_to_pick / when_not_to_pick where the evidence supports it. Do NOT drop options on the basis of these notes.`
        : "",
      "",
      "EVIDENCE GROUNDING:",
      "- Use comparison_matrix as the primary input for strong_axes / weak_axes.",
      "- No static pattern library. No invented evidence.",
      "- Citation IDs in citations must exist in the evidence pool.",
      "- citations for each option MUST cite external sources only. Items with",
      "  source_type: \"private_corpus\" describe the team's existing patterns —",
      "  they are decision CONTEXT, never external evidence for an option's",
      "  properties.",
      "- When citing a claim sourced from source_type: \"community_discussion\",",
      "  frame it as ADOPTION / PRACTITIONER signal — e.g. \"r/LocalLLaMA",
      "  practitioners report X\" or \"HN discussion notes Y\" — not as a hard",
      "  architectural fact.",
      "",
      "DIAGRAMS — emit Mermaid flowchart source for two specific fields:",
      "",
      "1. decision_space_diagram (top-level, required when there are ≥2 candidates):",
      "   flowchart LR with one central decision node and each candidate as a",
      "   sibling. Style nodes by evidence_depth using these classes:",
      "     classDef thick fill:#cfc,stroke:#363",
      "     classDef thin fill:#fcc,stroke:#933",
      "   Apply `class <name> thick` for evidence_depth=thick candidates and",
      "   `class <name> thin` for evidence_depth=thin candidates. Medium gets no",
      "   class. Total node count: keep ≤16. No subgraphs needed.",
      "",
      "2. options[].deployment_diagram (per concrete candidate):",
      "   flowchart LR showing how this candidate integrates with the user's",
      "   existing stack. Use subgraphs for layers (App / Data / Infra). Label",
      "   edges with protocol or operation (\"HNSW lookup\", \"REST\", \"embedding",
      "   upsert\"). Total nodes ≤15.",
      "",
      "   IMPORTANT: omit deployment_diagram entirely when the candidate is an",
      "   abstract category, generic pattern, or research concept rather than a",
      "   deployable system. \"Pgvector\" / \"Memgraph\" / \"Neo4j\" get diagrams;",
      "   \"Graph Database\" / \"Knowledge Graph\" / \"Bidirectional Knowledge Graph\"",
      "   do not. The reader can tell from the candidate's name and summary",
      "   whether a deployment topology makes sense.",
      "",
      "Mermaid rules (both fields):",
      "- Output bare Mermaid DSL only — no ```mermaid``` fences (the renderer",
      "  adds them).",
      "- No custom HTML, no clickable links, no themes beyond the classDef above.",
      "- Stable kebab-case IDs (so future diff detection works).",
      "- If you cannot produce a valid diagram for a field, OMIT the field",
      "  rather than emit broken syntax. Better no diagram than a broken one.",
      "",
      "Example decision_space_diagram (3 candidates):",
      "  flowchart LR",
      "    decision{Retrieval architecture}",
      "    decision --> pgvector[Pgvector]",
      "    decision --> pinecone[Pinecone]",
      "    decision --> weaviate[Weaviate]",
      "    classDef thick fill:#cfc,stroke:#363",
      "    classDef thin fill:#fcc,stroke:#933",
      "    class pgvector thick",
      "    class weaviate thin",
      "",
      ...(isResynth
        ? [
            "RE-SYNTHESIS MODE — the previous report was critiqued.",
            "Read prior_spec and prior_critique below. Your job is to IMPROVE",
            "the report:",
            "- If the critique says a candidate section is missing, add it.",
            "- If the critique says an option's strong_axes is unsupported by",
            "  its citations, weaken that option (move to weak_axes or note",
            "  in what_evidence_does_not_show).",
            "- If the critique says open_questions misses gaps, add them.",
            "Acknowledge in executive_summary which critique issues you addressed.",
            ""
          ]
        : []),
      "Output JSON: { id, title, executive_summary, decision_space_diagram, option_space_shape, options: [{ ..., deployment_diagram }], cross_cutting_tradeoffs: [...], open_questions: [...], domain_model, evidence_summary }."
    ].filter(Boolean).join("\n"),
    user: JSON.stringify({
      context,
      knowledge_map: knowledgeMap,
      comparison_matrix: comparisonMatrix,
      ...(isResynth
        ? {
            prior_spec: {
              executive_summary: priorSpec.executive_summary,
              options: toArray(priorSpec.options).map((o) => ({
                name: o.name,
                strong_axes: o.strong_axes,
                weak_axes: o.weak_axes
              })),
              open_questions: priorSpec.open_questions
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
  // private_corpus items describe team context, not external evidence. Drop
  // them from any option's citations even if the LLM emits them.
  const privateCorpusIds = new Set(
    evidenceItems
      .filter((item) => item.source_type === "private_corpus")
      .map((item) => Number(item.citation_id))
  );

  // Parse the model's options, filtering names that don't appear in the
  // candidate set. The synthesizer is forbidden from inventing candidates.
  const rawOptions = toArray(result.options);
  const dedupSeen = new Set();
  const options = [];
  const diagramFailures = []; // collected here; emitted via outDir below
  for (const opt of rawOptions) {
    const name = slugify(String(opt.name || "").trim());
    if (!name) continue;
    if (!candidateSet.has(name)) continue; // hallucinated; drop
    if (dedupSeen.has(name)) continue;
    dedupSeen.add(name);
    const declaredDepth = String(opt.evidence_depth || "").trim();
    const evidenceDepth = ["thick", "medium", "thin"].includes(declaredDepth)
      ? declaredDepth
      : depthByName.get(name) || "thin";
    const parsedOption = {
      name,
      label: String(opt.label || titleCase(name)),
      summary: String(opt.summary || ""),
      evidence_depth: evidenceDepth,
      what_evidence_shows: String(opt.what_evidence_shows || ""),
      what_evidence_does_not_show: String(opt.what_evidence_does_not_show || ""),
      strong_axes: toArray(opt.strong_axes).map(String).filter(Boolean),
      weak_axes: toArray(opt.weak_axes).map(String).filter(Boolean),
      when_to_pick: toArray(opt.when_to_pick).map(String).filter(Boolean).slice(0, 6),
      when_not_to_pick: toArray(opt.when_not_to_pick).map(String).filter(Boolean).slice(0, 6),
      citations: toArray(opt.citations)
        .map(Number)
        .filter((id) => Number.isFinite(id) && validCitationIds.has(id) && !privateCorpusIds.has(id))
    };
    // Per-candidate Mermaid deployment_diagram. Optional — the prompt instructs
    // the LLM to omit it for abstract categories. We only act when the field
    // is present: validate, attach on success, drop on failure.
    if (opt.deployment_diagram != null) {
      const validated = validateMermaidSource(opt.deployment_diagram);
      if (validated.ok) {
        parsedOption.deployment_diagram = String(opt.deployment_diagram).trim();
      } else {
        diagramFailures.push({
          section: `option:${name}:deployment_diagram`,
          error: validated.error
        });
      }
    }
    options.push(parsedOption);
  }

  // Backstop: every candidate in knowledge_map must have an options entry.
  // The prompt forbids skipping, but synthesizers occasionally drop candidates
  // when they think the evidence is too thin. Backstop with a minimal section
  // pointing at the candidate's evidence so nothing silently disappears from
  // the report.
  const optionsByName = new Map(options.map((o) => [o.name, o]));
  for (const candidate of candidateRecords) {
    if (optionsByName.has(candidate.name)) continue;
    options.push({
      name: candidate.name,
      label: candidate.label || titleCase(candidate.name),
      summary: "",
      evidence_depth: candidate.evidence_depth || "thin",
      what_evidence_shows:
        "The synthesizer did not produce a section for this candidate. The cited evidence is preserved below.",
      what_evidence_does_not_show: "",
      strong_axes: [],
      weak_axes: [],
      when_to_pick: [],
      when_not_to_pick: [],
      citations: toArray(candidate.citations)
        .map(Number)
        .filter((id) => Number.isFinite(id) && validCitationIds.has(id) && !privateCorpusIds.has(id))
    });
  }

  // cross_cutting_tradeoffs — keep candidates_high / candidates_low names
  // only if they match real options.
  const optionNameSet = new Set(options.map((o) => o.name));
  const crossCuttingTradeoffs = toArray(result.cross_cutting_tradeoffs)
    .map((t) => {
      if (!t || typeof t !== "object") return null;
      const axis = String(t.axis || "").trim();
      const observation = String(t.observation || "").trim();
      if (!axis || !observation) return null;
      return {
        axis,
        observation,
        candidates_high: toArray(t.candidates_high)
          .map((n) => slugify(String(n || "")))
          .filter((n) => n && optionNameSet.has(n)),
        candidates_low: toArray(t.candidates_low)
          .map((n) => slugify(String(n || "")))
          .filter((n) => n && optionNameSet.has(n))
      };
    })
    .filter(Boolean);

  const openQuestions = toArray(result.open_questions)
    .map((q) => String(q || "").trim())
    .filter(Boolean)
    .slice(0, 12);

  const executiveSummary = String(result.executive_summary || "").trim()
    || (options.length === 0
      ? "No candidates surfaced in the evidence pool. The decision space could not be mapped from the available evidence — re-run with sharper context."
      : `${options.length} candidates surfaced in the option space. See per-candidate sections for what the evidence shows and what it does not.`);

  const optionSpaceShape = String(result.option_space_shape || "").trim();

  // Top-level decision_space_diagram. Same validate-or-drop pattern as the
  // per-option deployment_diagram above. Collected into diagramFailures so
  // we emit all failures in one event at the end.
  let decisionSpaceDiagram = null;
  if (result.decision_space_diagram != null) {
    const validated = validateMermaidSource(result.decision_space_diagram);
    if (validated.ok) {
      decisionSpaceDiagram = String(result.decision_space_diagram).trim();
    } else {
      diagramFailures.push({
        section: "decision_space_diagram",
        error: validated.error
      });
    }
  }

  if (outDir && diagramFailures.length > 0) {
    await appendEvent(outDir, "diagram_validation_failed", {
      failure_count: diagramFailures.length,
      failures: diagramFailures
    });
  }

  return {
    version: VERSION,
    id: result.id || "ADR-001",
    title: result.title || titleCase(context.decision),
    executive_summary: executiveSummary,
    ...(decisionSpaceDiagram ? { decision_space_diagram: decisionSpaceDiagram } : {}),
    option_space_shape: optionSpaceShape,
    options,
    cross_cutting_tradeoffs: crossCuttingTradeoffs,
    open_questions: openQuestions,
    domain_model: {
      bounded_contexts: toArray(result.domain_model?.bounded_contexts),
      core_entities: toArray(result.domain_model?.core_entities),
      domain_invariants: toArray(result.domain_model?.domain_invariants)
    },
    evidence_summary:
      result.evidence_summary &&
      typeof result.evidence_summary === "object" &&
      !Array.isArray(result.evidence_summary)
        ? result.evidence_summary
        : {},
    evidence: evidenceItems.slice(0, 16).map((item) => ({
      label: `[${item.citation_id}] ${item.title}`,
      url: item.url,
      relevance: item.relevance,
      source_type: item.source_type,
      score: item.score
    }))
  };
}

async function buildEvaluationPack(context, spec, evidenceItems, comparisonMatrix = null, options = {}) {
  const reportOptions = toArray(spec.options);
  const targetOptionName = options.targetOptionName
    ? slugify(String(options.targetOptionName).trim())
    : null;

  // When no candidates surfaced, return an honest empty pack rather than
  // fabricate test cases.
  if (reportOptions.length === 0) {
    return {
      version: VERSION,
      suite: slugify(context.domain || "architecture_deep_research_suite"),
      target_topologies: [],
      metrics: {},
      test_cases: [],
      mode: "deferred"
    };
  }

  // If a target option was passed (handoff flow), scope to that one option;
  // otherwise generate across the whole option set (legacy behavior).
  const scopedOptions = targetOptionName
    ? reportOptions.filter((o) => slugify(o.name) === targetOptionName)
    : reportOptions;

  if (scopedOptions.length === 0) {
    return {
      version: VERSION,
      suite: slugify(context.domain || "architecture_deep_research_suite"),
      target_topologies: [],
      metrics: {},
      test_cases: [],
      mode: "deferred"
    };
  }

  const result = await callLlmJson({
    label: "evaluation_pack_agent",
    system: [
      "You generate the domain evaluation pack for Architecture Deep Research.",
      "",
      "The pack is what a downstream coding agent runs AFTER implementing one",
      "of the candidates to verify the implementation actually delivers what",
      "the candidate's evidence claimed. It is NOT a generic test suite — it",
      "must be specific to this decision, the candidate(s) below, and their",
      "claimed strong_axes.",
      "",
      `Decision: "${context.decision}"`,
      `Domain: "${context.domain}"`,
      "",
      "INPUTS:",
      "- options[]: candidate(s) with strong_axes, weak_axes, when_to_pick,",
      "  when_not_to_pick. Test cases should cover each candidate's claimed",
      "  strong_axes (verify the strength holds in practice) AND the",
      "  weak_axes (verify the weakness is documented, not a surprise).",
      "- comparison_matrix: shows which axis verdicts came from evidence.",
      "",
      "REQUIRED OUTPUT — be specific, not generic:",
      "- 6 to 12 test_cases. Each one must:",
      "    * name a target_topology from options[].name OR multiple",
      "      (a test that all candidates must pass)",
      "    * test a CONCRETE behavior with measurable acceptance_criteria",
      "    * NOT be a generic \"is the API up\" test",
      "  Anchor each test to the candidate's claimed strong_axes / weak_axes.",
      "- 3 to 6 metrics. Each one has a numeric target and a definition.",
      "",
      "DO NOT return an empty test_cases array. DO NOT return an empty metrics",
      "object.",
      "",
      "Output JSON: {suite: string, target_topologies: [string], metrics: object, test_cases: [object]}."
    ].join("\n"),
    user: JSON.stringify({
      context,
      options: scopedOptions.map((o) => ({
        name: o.name,
        label: o.label,
        summary: o.summary,
        when_to_pick: o.when_to_pick,
        when_not_to_pick: o.when_not_to_pick,
        strong_axes: o.strong_axes,
        weak_axes: o.weak_axes,
        citations: o.citations
      })),
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
    : scopedOptions.map((o) => o.name);

  return {
    version: VERSION,
    suite: result.suite || slugify(context.domain || "architecture_deep_research_suite"),
    target_topologies: targetTopologies,
    metrics: normalizeEvaluationMetrics(result.metrics),
    test_cases: normalizeEvaluationCases(result.test_cases).slice(0, 12)
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

// buildGuardrails writes agent-guardrails.md scoped to one chosen option.
// Called from the `adr handoff` subcommand, NOT from the default pipeline.
function buildGuardrails(spec, { targetOptionName = null } = {}) {
  const reportOptions = toArray(spec.options);
  const allowedAgenticUse = toArray(spec.evidence_summary?.allowed_agentic_use);

  if (reportOptions.length === 0) {
    return `# Agent Guardrails: ${spec.title || "(untitled)"}

## No candidates identified

ADR did not surface candidates for this decision. The evidence collected
did not produce a candidate set. There is nothing to enforce.

## What to do next

- Re-run with sharper context (better PRD, narrower decision focus).
- Or run \`adr supersede <out-dir>\` after collecting more evidence.
`;
  }

  const targetSlug = targetOptionName ? slugify(String(targetOptionName).trim()) : null;
  const chosen = targetSlug
    ? reportOptions.find((o) => slugify(o.name) === targetSlug)
    : null;

  if (targetSlug && !chosen) {
    const names = reportOptions.map((o) => o.name).join(", ");
    throw new Error(
      `Option "${targetOptionName}" not found in research-report.json. Available options: ${names}`
    );
  }

  const optionsToRender = chosen ? [chosen] : reportOptions;

  const optionBlocks = optionsToRender
    .map((opt) => {
      const pickWhen = (opt.when_to_pick || [])
        .map((item) => `- ${item}`)
        .join("\n") || "- (model did not provide \"when to pick\" conditions)";
      const avoidWhen = (opt.when_not_to_pick || [])
        .map((item) => `- ${item}`)
        .join("\n") || "- (model did not provide \"when NOT to pick\" conditions)";
      const strong = (opt.strong_axes || []).join(", ") || "—";
      const weak = (opt.weak_axes || []).join(", ") || "—";
      const evidence = (opt.citations || []).map((id) => `[${id}]`).join(", ") || "none";
      return `## Option: \`${opt.name}\` — ${opt.label}

${opt.summary || ""}

**Evidence depth:** ${opt.evidence_depth || "thin"}

### Pick this when
${pickWhen}

### Avoid when
${avoidWhen}

### Strong on
${strong}

### Weak on
${weak}

### Evidence
${evidence}
`;
    })
    .join("\n---\n\n");

  const header = chosen
    ? `Scope: implementation contract for **\`${chosen.name}\`**. The reader chose this option from the research report; honor its conditions below.`
    : `Scope: ${reportOptions.length} candidates from the research report. No option chosen — re-run \`adr handoff --option <name>\` to scope this file to one candidate.`;

  return `# Agent Guardrails: ${spec.title || "(untitled)"}

${header}

## How to read this file

ADR produces a research report. This guardrails file translates the chosen
candidate into an implementation contract: the conditions the candidate was
strong / weak on, what the cited evidence supports, and where to be careful.

${optionBlocks}

## Agentic use

${allowedAgenticUse.map((item) => `- ${item}`).join("\n") || "- (no agentic constraints carried over from synthesis)"}

Do not replace the chosen candidate with an easier local implementation path
without producing a superseding ADR.
`;
}

function buildADR(context, spec, knowledgeMap, evidenceItems = [], runMetadata = {}) {
  const options = toArray(spec.options);
  const generatedDate = String(runMetadata.generated_at || nowIso()).slice(0, 10);
  const candidateCount = options.length;
  const evidenceCount = toArray(evidenceItems).length;
  const costSummary = runMetadata.estimated_usd != null
    ? `$${Number(runMetadata.estimated_usd).toFixed(4)}`
    : "—";
  const llmCalls = runMetadata.total_llm_calls || 0;

  const headerLine = `*Generated ${generatedDate} · ${candidateCount} candidates · ${evidenceCount} evidence pieces · ${costSummary} · ${llmCalls} LLM calls*`;

  const summaryTable = options.length > 0
    ? `| Candidate | Evidence depth | Strong on | Weak on |
| --- | --- | --- | --- |
${options.map((opt) => {
  const strong = (opt.strong_axes || []).slice(0, 4).join(", ") || "—";
  const weak = (opt.weak_axes || []).slice(0, 4).join(", ") || "—";
  return `| ${opt.label || opt.name} | ${opt.evidence_depth || "thin"} | ${strong} | ${weak} |`;
}).join("\n")}`
    : "_(No candidates surfaced from the evidence pool.)_";

  const candidateSections = options
    .map((opt) => {
      const summary = (opt.summary || "").trim();
      const shows = (opt.what_evidence_shows || "").trim();
      const gaps = (opt.what_evidence_does_not_show || "").trim();
      const pickWhen = (opt.when_to_pick || []).map((item) => `- ${item}`).join("\n");
      const avoidWhen = (opt.when_not_to_pick || []).map((item) => `- ${item}`).join("\n");
      const strong = (opt.strong_axes || []).join(", ") || "—";
      const weak = (opt.weak_axes || []).join(", ") || "—";
      const evidence = (opt.citations || []).map((id) => `[${id}]`).join(", ") || "none";
      // The deployment diagram (when present) lands between "What the
      // evidence shows" and "What the evidence does not show" — it visualizes
      // the positive claim before the prose pivots to gaps. Absent for
      // abstract / category candidates by design.
      const deploymentDiagramBlock = opt.deployment_diagram
        ? `\n\n\`\`\`mermaid\n${opt.deployment_diagram}\n\`\`\``
        : "";
      return `### ${opt.label || titleCase(opt.name)} (evidence: ${opt.evidence_depth || "thin"})

${summary || "_(no summary provided)_"}

**What the evidence shows.** ${shows || "_(no synthesis provided)_"}${deploymentDiagramBlock}

**What the evidence does not show.** ${gaps || "_(no gap analysis provided)_"}

**Pick when:**

${pickWhen || "- (model did not provide \"when to pick\" conditions)"}

**Avoid when:**

${avoidWhen || "- (model did not provide \"when NOT to pick\" conditions)"}

**Strong on:** ${strong}
**Weak on:** ${weak}
**Citations:** ${evidence}`;
    })
    .join("\n\n");

  const tradeoffs = toArray(spec.cross_cutting_tradeoffs);
  const tradeoffSection = tradeoffs.length > 0
    ? tradeoffs
        .map((t) => {
          const high = (t.candidates_high || []).join(", ") || "—";
          const low = (t.candidates_low || []).join(", ") || "—";
          return `### ${t.axis}

${t.observation}

- Strong: ${high}
- Weak: ${low}`;
        })
        .join("\n\n")
    : "_(No cross-cutting tradeoffs surfaced from the matrix.)_";

  const openQuestions = toArray(spec.open_questions);
  const openQuestionsSection = openQuestions.length > 0
    ? openQuestions.map((q) => `- ${q}`).join("\n")
    : "_(No open questions surfaced from the evidence pool.)_";

  const evidenceFromRepo = (() => {
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
    return `\n## Evidence from your repo (discover stage)

The repo scan surfaced these patterns + antipatterns as private-corpus evidence. They voted in the comparison matrix alongside the web research:

${items}
`;
  })();

  const references = (() => {
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
  })();

  // Map-of-the-territory diagram lands right after the executive summary
  // text. Optional — synthesizer omits it for runs with <2 candidates or
  // when the LLM couldn't produce valid Mermaid.
  const decisionSpaceDiagramBlock = spec.decision_space_diagram
    ? `\n\n\`\`\`mermaid\n${spec.decision_space_diagram}\n\`\`\``
    : "";

  return `# Research report: ${spec.title || titleCase(context.decision)}

${headerLine}

## Executive Summary

${(spec.executive_summary || "").trim() || "_(no executive summary generated)_"}${decisionSpaceDiagramBlock}

## Option Space

${(spec.option_space_shape || "").trim() || "_(no option-space shape provided)_"}

${summaryTable}

## Candidates

${candidateSections || "_(No candidates were surfaced by this run.)_"}

## Cross-Cutting Tradeoffs

${tradeoffSection}

## Open Questions

${openQuestionsSection}

## Evidence Acquisition

${knowledgeMap.acquisition_rule || "Architecture families are extracted from the live evidence pool. Each candidate's depth (thick / medium / thin) reflects how much corroborating evidence was found."}

Candidates surfaced:
${toArray(knowledgeMap.candidates).map((item) => `- ${item.label} (evidence: ${item.evidence_depth || "thin"}): citations ${item.citations.map((id) => `[${id}]`).join(", ")}`).join("\n") || "- No candidate surfaced."}
${evidenceFromRepo}
${references}`;
}

// buildExecutionHandoff is called from the `adr handoff` subcommand only.
// It consumes the research report and a chosen option name, then writes an
// implementation contract for that one option.
function buildExecutionHandoff(spec, { targetOptionName = null } = {}) {
  const reportOptions = toArray(spec.options);
  const targetSlug = targetOptionName ? slugify(String(targetOptionName).trim()) : null;
  const chosen = targetSlug
    ? reportOptions.find((o) => slugify(o.name) === targetSlug)
    : null;

  if (targetSlug && !chosen) {
    const names = reportOptions.map((o) => o.name).join(", ");
    throw new Error(
      `Option "${targetOptionName}" not found in research-report.json. Available options: ${names}`
    );
  }

  const optionsBlock = chosen
    ? [chosen]
    : reportOptions;

  return {
    version: VERSION,
    decision_id: spec.id || "ADR-001",
    handoff_boundary: "adr_stops_at_research_report",
    chosen_option: chosen ? chosen.name : null,
    options: optionsBlock.map((opt) => ({
      name: opt.name,
      label: opt.label,
      summary: opt.summary,
      evidence_depth: opt.evidence_depth || "thin",
      when_to_pick: opt.when_to_pick || [],
      when_not_to_pick: opt.when_not_to_pick || [],
      strong_axes: opt.strong_axes || [],
      weak_axes: opt.weak_axes || [],
      citations: opt.citations || []
    })),
    artifacts: {
      adr: "ADR.md",
      research_report: "research-report.json",
      domain_evaluation_pack: "domain-evaluation-pack.json",
      agent_guardrails: "agent-guardrails.md",
      sources: "sources.md",
      strategic_context: "strategic-context.json",
      research_plan: "research-plan.json",
      research_report_markdown: "research-report.md",
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
  adrMarkdown,
  researchReport,
  evidenceItems,
  outDir
}) {
  await appendEvent(outDir, "claim_audit_started", {
    artifact_count: 3
  });
  let raw;
  try {
    raw = await callLlmJson({
      label: "uncited_claim_scanner",
      system: [
        "You audit generated Architecture Deep Research artifacts for material architecture claims.",
        "Find claims in ADR.md, research-report.md, research-report.json that need citations or stronger evidence.",
        "Do not flag headings, generic process text, or restatements of the user's product context.",
        "A claim is material when it compares, scores, or asserts a candidate's capability, risk, latency, cost, reliability, compliance, or evidence quality.",
        "If a material claim is already supported by the cited evidence pool, include the citation_ids.",
        "If it is not supported or has no clear citation, set needs_citation:true.",
        "Output JSON with {claims:[{artifact,claim_text,citation_ids:[number],needs_citation:boolean,severity:'high'|'medium'|'low',reason:string}],summary:string}."
      ].join("\n"),
      user: JSON.stringify({
        domain: context.domain,
        decision: context.decision,
        artifacts: {
          adr_markdown: adrMarkdown.slice(0, 18_000),
          research_report: researchReport.slice(0, 18_000),
          research_report_json: spec
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

function buildResearchReportMarkdown({ context, plan, spec, evidenceItems, researchResults, knowledgeMap }) {
  const topEvidence = evidenceItems.slice(0, 10);
  const candidates = toArray(spec.options);
  const candidatesLine = candidates.length > 0
    ? `ADR mapped **${candidates.length} candidates** in the option space for **${context.domain}**. The decision is yours; see \`ADR.md\` for the full per-candidate report and \`where-to-dig-deeper.json\` for the sharper sub-research threads.`
    : `ADR did not surface candidates for **${context.domain}**. See \`critique.json\` and re-run with sharper context.`;

  return `# Architecture Deep Research Report

## Decision space

${candidatesLine}

## Research Mode

- Live search providers only.
- LLM-driven planning, claim extraction, synthesis, and adversarial evaluation generation.
- No offline mode.
- No static pattern oracle.

## Research Coverage

${(plan.tasks || []).map((task) => `- ${task.id}: ${task.title}`).join("\n")}

## Knowledge Acquisition

Candidates surfaced:
${toArray(knowledgeMap.candidates).map((item) => `- ${item.label} (evidence: ${item.evidence_depth || "thin"}): ${item.evidence_count} claims, citations ${item.citations.map((id) => `[${id}]`).join(", ")}`).join("\n") || "- None."}

${toArray(knowledgeMap.off_topic_candidates).length > 0 ? `Off-topic candidates filtered out:
${toArray(knowledgeMap.off_topic_candidates).map((item) => `- ${item.label}: ${item.evidence_count} claims`).join("\n")}
` : ""}

## Evidence Summary

${topEvidence
  .map((item) => `- [${item.citation_id}] ${item.title}: ${item.claims[0]?.claim || item.excerpt.slice(0, 320)}`)
  .join("\n") || "- No external evidence was collected."}

## Intermediate Reports

${researchResults.map((result) => result.report).join("\n")}

## Boundary

ADR stops at the research report. The reader decides which candidate fits their context; \`adr handoff\` produces an implementation contract for the chosen candidate when needed.
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

  // Clobber guard: if outDir contains a completed run, refuse to overwrite
  // unless the caller explicitly opts in. Fresh runs append to events.jsonl
  // and writeJson the final artifacts — without this guard, a re-run bills
  // the user, the events log shows the new run_completed, but a late-stage
  // crash (or any path that bypasses writeRunArtifacts) leaves stale
  // state.json / ADR.md / architecture.spec.json on disk. The user pays for
  // invisible work and the on-disk artifacts contradict the event stream.
  if (!chained && !flags.resume && !flags.overwrite) {
    try {
      const priorState = JSON.parse(
        await readFile(path.join(outDir, "state.json"), "utf8")
      );
      if (priorState?.status === "completed") {
        throw new Error(
          `Out dir ${outDir} already contains a completed run ` +
          `(${priorState.candidate_count ?? "?"} candidates). ` +
          `Re-running would discard those artifacts and bill you again. ` +
          `Pick one:\n` +
          `  - Use a different --out path for a fresh run\n` +
          `  - 'adr resume ${outDir}' to replay synthesis from cached evidence (cheap)\n` +
          `  - Pass --overwrite to force a fresh run that replaces the prior artifacts`
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        // Re-throw our own clobber error; ENOENT and JSON-parse errors are
        // expected on first run / corrupt prior state and should not block.
        throw error;
      }
    }
  }

  await mkdir(outDir, { recursive: true });
  if (!chained && !flags.resume) {
    // Fresh run — truncate events.jsonl and reset cost tracking. When chained
    // from --discover-first, the upstream discover stage already initialized
    // both, and we want to preserve its events on the same log. When
    // --resume, keep the existing events.jsonl so the resume picks up where
    // the prior run died.
    await writeFile(path.join(outDir, "events.jsonl"), "");
    resetLlmCost();
  } else if (flags.resume) {
    await appendEvent(outDir, "run_resumed", {
      out_dir: outDir,
      decision: flags.decision,
      domain: flags.domain
    });
  }

  // Persist run-config.json so `adr resume <out_dir>` can re-invoke with
  // the original flag set. Only write on a fresh run (resume re-reads it).
  // Persists every flag the caller passed (minus `resume` itself, which
  // is set by the resume command, not the original invocation).
  if (!flags.resume) {
    try {
      const { resume: _ignoredResume, ...persistedFlags } = flags;
      const runConfig = {
        version: VERSION,
        started_at: nowIso(),
        input_path: inputPath || null,
        flags: persistedFlags
      };
      await writeFile(
        path.join(outDir, "run-config.json"),
        JSON.stringify(runConfig, null, 2)
      );
    } catch {
      // run-config write failures are non-fatal — resume just won't work
      // without it, but the current run will still complete.
    }
  }
  await appendEvent(outDir, "run_started", {
    command: "deep-research",
    runtime,
    input_path: inputPath,
    domain: flags.domain,
    decision: flags.decision,
    ...(chained ? { chained_from: "discover" } : {})
  });

  const context = await buildStrategicContext({
    sourcePath: inputPath,
    content,
    domain: flags.domain,
    decision: flags.decision
  });

  // Detect missing context but DO NOT halt. Surface the gaps as a
  // non-blocking event so the streaming UI can show them; the run still
  // proceeds. Follow-up questions are also derived post-run from matrix
  // axis variance.
  const clarification = assessClarification(context, content);
  await writeJson(path.join(outDir, "strategic-context.json"), context);
  await writeJson(path.join(outDir, "clarification.json"), clarification);
  await appendEvent(outDir, "strategic_context_created", {
    query_shapes: context.query_shapes.map((shape) => shape.name),
    bounded_contexts: context.bounded_contexts,
    needs_clarification: clarification.needs_clarification
  });
  if (clarification.needs_clarification && clarification.questions.length > 0) {
    await appendEvent(outDir, "decision_context_gaps_detected", {
      gap_count: clarification.questions.length,
      gaps: clarification.questions
    });
  }

  // Decision context notes — extracted ONCE per outDir (file-cached).
  // These are annotations on the option space, never filters. The user can
  // edit decision-context.json between runs and the file will be picked up
  // unchanged on re-invocation.
  const decisionContext = await extractDecisionContext({
    context,
    content,
    outDir,
    flags
  });

  // Thread decision-context notes onto the context object so the synthesis
  // prompt can surface them as soft annotations.
  context.decision_context_notes = decisionContext.notes;
  context.decision_context_tags = decisionContext.tags;

  return {
    runtime,
    outDir,
    content,
    context,
    clarification,
    needsClarification: false,
    decisionContext
  };
}

// Per-task max queries — used to cap "both"-strategy peers so they don't
// blow the per-peer query budget by emitting architecture + adoption sets in
// full. Architecture queries win the cap (peer's architecture, when public,
// is the highest-signal evidence).
const PEER_TASK_MAX_QUERIES = 5;

// Architecture-strategy queries: today's behavior. Targets engineering blogs,
// public github, ARCHITECTURE.md / docs. Use when the peer's architecture is
// publicly documented.
function architecturePeerQueries({ label, decision, peer }) {
  return [
    `${label} ${decision} architecture`,
    `${label} ${decision} site:github.com`,
    peer.engineering_blog_url
      ? `${label} ${decision} blog`
      : `${label} how they built ${decision}`
  ];
}

// Adoption-strategy queries: targets community signal — Reddit, HN, Twitter,
// reverse-engineering posts, migration write-ups. Use when the peer is
// closed-source or otherwise lacks public architecture docs but carries real
// adoption signal (Obsidian, Roam, Mem.ai, Notion).
//
// The LLM picks relevant subreddits / communities per topic — we don't
// hardcode a subreddit list because the right community varies per decision.
async function adoptionPeerQueries({ context, peer }) {
  const label = peer.label || peer.name;
  const decisionAspect = context.decision;
  const useCase = context.domain || decisionAspect;
  try {
    const raw = await callLlmJson({
      label: "adoption_research_planner",
      system: [
        "You are the adoption-research query planner for Architecture Deep Research.",
        "",
        "This peer is closed-source or lacks public architecture docs, but it",
        "carries real ADOPTION signal — community size, plugin ecosystems,",
        "\"we tried X and switched to Y\" threads, reverse-engineering posts,",
        "practitioner pain points. Your job is to generate search queries that",
        "target that signal, not engineering blogs.",
        "",
        "Generate 4-6 queries that route to community discussion (Reddit, HN,",
        "Twitter/X, Stack Exchange) and migration / reverse-engineering write-ups.",
        "",
        "Include a mix of these shapes (adapt the exact wording to the peer +",
        "decision; do not just template-fill):",
        "  - <peer> reddit users architecture experience <decision_aspect>",
        "  - <peer> hacker news comments <decision_aspect>",
        "  - site:reddit.com <peer> <use_case>",
        "  - site:news.ycombinator.com <peer>",
        "  - site:twitter.com <peer> <decision_aspect>",
        "  - how does <peer> store data / <peer> internals reverse engineering",
        "  - <peer> vs <known_competitor> migration",
        "",
        "Pick the relevant subreddit / community when one is well-known for",
        "this decision (e.g. r/LocalLLaMA for local LLM tools, r/ObsidianMD",
        "for Obsidian). Do not hardcode a single subreddit — choose what fits",
        "the peer + decision.",
        "",
        "Output JSON: { queries: [string] }."
      ].join("\n"),
      user: JSON.stringify({
        peer: {
          name: peer.name,
          label,
          why_comparable: peer.why_comparable || ""
        },
        decision_aspect: decisionAspect,
        use_case: useCase,
        domain: context.domain
      })
    });
    const queries = toArray(raw.queries)
      .map((q) => String(q || "").trim())
      .filter(Boolean)
      .slice(0, 6);
    if (queries.length > 0) return queries;
  } catch {
    // Fall through to a deterministic fallback so a planner failure never
    // strands an adoption-strategy peer with zero queries.
  }
  // Fallback: deterministic adoption-shaped queries built without the LLM.
  return [
    `${label} reddit users architecture experience ${decisionAspect}`,
    `${label} hacker news comments ${decisionAspect}`,
    `site:reddit.com ${label} ${useCase}`,
    `site:news.ycombinator.com ${label}`,
    `how does ${label} store data`
  ];
}

// Build research tasks targeting peer products from peers.json (when present).
// Real users picking architectures look at 3-5 similar products to see what
// they did. One task per peer, narrowly scoped to how that peer handles the
// SPECIFIC decision (not their entire architecture).
//
// Query shape branches on evidence_strategy:
//   architecture: github repo + docs + engineering blog (today's behavior)
//   adoption:     reddit / HN / twitter / migration write-ups
//   both:         merged set, capped at PEER_TASK_MAX_QUERIES
//                 (architecture wins ties).
async function buildPeerResearchTasks({ context, outDir }) {
  let peersArtifact;
  try {
    peersArtifact = JSON.parse(await readFile(path.join(outDir, "peers.json"), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { tasks: [], status: "no_peers_json" };
    }
    return { tasks: [], status: "peers_json_unreadable", error: String(error?.message || error) };
  }
  const peers = toArray(peersArtifact?.peers);
  if (peers.length === 0) {
    return { tasks: [], status: "peers_json_empty" };
  }

  const tasks = await Promise.all(peers.map(async (peer, index) => {
    const sources = [
      peer.github_url,
      peer.docs_url,
      peer.engineering_blog_url,
      peer.homepage_url
    ]
      .map((s) => String(s || "").trim())
      .filter(Boolean);
    const label = peer.label || peer.name;
    const strategy =
      typeof peer.evidence_strategy === "string"
        ? peer.evidence_strategy.trim().toLowerCase()
        : "architecture";

    let search_queries;
    if (strategy === "adoption") {
      search_queries = await adoptionPeerQueries({ context, peer });
    } else if (strategy === "both") {
      const archQs = architecturePeerQueries({ label, decision: context.decision, peer });
      const adoptQs = await adoptionPeerQueries({ context, peer });
      // Architecture queries first so when the cap fires they survive.
      search_queries = [...archQs, ...adoptQs].slice(0, PEER_TASK_MAX_QUERIES);
    } else {
      search_queries = architecturePeerQueries({ label, decision: context.decision, peer });
    }

    const isAdoptionShape = strategy === "adoption" || strategy === "both";
    const objective = isAdoptionShape
      ? `Find ADOPTION evidence of how ${label} (${peer.why_comparable || "a comparable product"}) handles ${context.decision}: community discussion, practitioner pain points, plugin / integration ecosystem, "we tried X and switched to Y" threads. ${label} is researched via Reddit / HN / Twitter / reverse-engineering posts because its architecture isn't publicly documented but its adoption signal is real.`
      : `Find evidence of how ${label} (${peer.why_comparable || "a comparable product"}) handles the specific decision aspect: ${context.decision}. Look at their public repo, ARCHITECTURE.md, docs, and engineering blog. Extract their specific choice (e.g. pgvector vs Pinecone, BullMQ vs Trigger.dev) with the citation pointing at the file or URL where they made that choice.`;

    const success_criteria = isAdoptionShape
      ? [
          `Identify what ${label}'s practitioner community says about ${context.decision} — ecosystem traction, integration breadth, common pain points.`,
          `Capture concrete adoption signals (subreddit size, plugin counts, migration stories) when the cited sources expose them.`
        ]
      : [
          `Identify the specific ${context.decision} ${label} uses, with a citation to ${peer.github_url || peer.docs_url || "their public docs"}.`,
          `Capture quantitative signals (scale, version, deployment shape) when ${label}'s sources expose them.`
        ];

    return {
      id: `peer_${slugify(peer.name)}_${index + 1}`,
      title: `Peer ${isAdoptionShape ? "adoption" : "architecture"}: how ${label} handles ${context.decision}`,
      objective,
      search_queries,
      source_targets: sources,
      success_criteria,
      peer_target: peer.name,
      evidence_strategy: strategy === "adoption" || strategy === "both" ? strategy : "architecture"
    };
  }));
  return { tasks, status: "ok" };
}

async function planResearchPhase({ context, content, outDir, flags }) {
  const plan = await buildResearchPlan(context, content);

  // Peer-targeted tasks land BEFORE the LLM-generated tasks so the bounded
  // slice always preserves at least one task per peer. Without this,
  // max_cycles=1 with many peers could drop most peer tasks.
  const peerResult = await buildPeerResearchTasks({ context, outDir });
  const peerTasks = peerResult.tasks;
  // Visibility: a user who passed --include-peers and sees peer_task_count=0
  // in research_plan_created previously had no event explaining why. Emit
  // the reason explicitly so silent failures (missing peers.json, empty
  // peers array, unreadable file) are surfaced. Skipped when peer tasks
  // landed normally or when --include-peers wasn't requested.
  if (peerTasks.length === 0 && flags["include-peers"]) {
    await appendEvent(outDir, "peer_research_tasks_skipped", {
      reason: peerResult.status,
      hint:
        peerResult.status === "no_peers_json"
          ? "peers.json was not found in outDir. Either discover didn't run with --include-peers in this outDir, or it was deleted between discover and deep-research. In chained mode (--discover-first), both stages must share outDir."
          : peerResult.status === "peers_json_empty"
            ? "peers.json was present but contained no peers. Check the discover stage's peers_extraction_empty event for the underlying cause; provide --seed <product> to anchor the finder."
            : peerResult.status === "peers_json_unreadable"
              ? `peers.json could not be read or parsed: ${peerResult.error || "unknown error"}`
              : "buildPeerResearchTasks returned no tasks for an unrecognized reason."
    });
  }
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

// Extract decision-context notes from the PRD + clarification answers.
//
// These notes are ANNOTATIONS, never filters. "Self-hosted only" lands here
// as a context note attached to each option's deployment annotation, not as
// a pre-filter that drops candidates. The reader (or the team specialist)
// decides which notes are dealbreakers for their context — ADR's job is to
// map the option space, not narrow it.
//
// Persists as decision-context.json. If the file already exists in outDir
// (user edited it), it is used as-is — same edit-and-re-run UX as pdr.draft.md.
async function extractDecisionContext({ context, content, outDir, flags, tags = [] }) {
  const contextPath = path.join(outDir, "decision-context.json");
  try {
    const existing = JSON.parse(await readFile(contextPath, "utf8"));
    if (existing && Array.isArray(existing.notes)) {
      await appendEvent(outDir, "decision_context_loaded_from_disk", {
        note_count: existing.notes.length
      });
      return existing;
    }
  } catch {
    // File doesn't exist or is corrupt — extract fresh below.
  }

  if (flags && flags["skip-decision-context"]) {
    return {
      version: VERSION,
      decision: context.decision,
      domain: context.domain,
      tags,
      notes: []
    };
  }

  let raw;
  try {
    raw = await callLlmJson({
      label: "decision_context_extractor",
      system: [
        "You are the decision-context extractor for Architecture Deep Research.",
        "",
        `Decision: "${context.decision}"`,
        `Domain: "${context.domain}"`,
        "",
        "Read the user's PRD + clarification answers. Extract CONTEXT NOTES",
        "that describe the user's situation and would help a reader weigh the",
        "tradeoffs across the option space. These are NOT filters. They will",
        "be shown alongside the ranked options so the reader sees which",
        "options fit and which don't, but ADR will not drop any candidate on",
        "the basis of these notes. The user picks among the options.",
        "",
        "Examples of context notes (extract these):",
        "  - deployment: 'Self-hosted on Docker Compose; no managed services for now.'",
        "  - data residency: 'Data must stay in EU; right-to-deletion required.'",
        "  - cost: 'Budget under $50/mo at current scale; free tier preferred.'",
        "  - integration: 'Existing Postgres + Next.js stack we want to extend.'",
        "  - region / latency: 'p95 < 200ms for user-facing queries.'",
        "  - team / phase: 'Solo founder, pre-PMF, time-to-ship dominates.'",
        "  - compliance: 'SOC2 Type II required in 12 months.'",
        "",
        "Note shape:",
        "  { id (kebab-case slug),",
        "    category (deployment | compliance | cost | region | integration | data | team | phase),",
        "    statement (the user's words, one sentence),",
        "    evidence_from_input (verbatim quote from PRD or clarification answers) }",
        "",
        "Quote evidence_from_input verbatim. Do not invent notes.",
        "",
        "Cap at 10 notes. Skip generic application-layer requirements",
        "('must support tenant isolation', 'must support agent identities') —",
        "those are features of the system the chosen option supports, not",
        "context that helps the reader choose between options.",
        "",
        "Output JSON: { notes: [{id, category, statement, evidence_from_input}] }."
      ].join("\n"),
      user: JSON.stringify({
        domain: context.domain,
        decision: context.decision,
        prd_content: content.slice(0, 20_000)
      })
    });
  } catch (error) {
    await appendEvent(outDir, "decision_context_extraction_failed", {
      error: String(error?.message || error)
    });
    return {
      version: VERSION,
      decision: context.decision,
      domain: context.domain,
      tags,
      notes: []
    };
  }

  const notes = toArray(raw.notes)
    .map((c, i) => {
      if (!c || typeof c !== "object") return null;
      const statement = String(c.statement || "").trim();
      if (!statement) return null;
      return {
        id: slugify(String(c.id || statement).slice(0, 64)) || `note_${i + 1}`,
        category: String(c.category || "").trim(),
        statement,
        evidence_from_input: String(c.evidence_from_input || "").trim()
      };
    })
    .filter(Boolean)
    .slice(0, 10);

  const out = {
    version: VERSION,
    decision: context.decision,
    domain: context.domain,
    extracted_at: nowIso(),
    tags: toArray(tags).map(String).filter(Boolean),
    notes
  };

  await writeJson(contextPath, out);
  await appendEvent(outDir, "decision_context_extracted", {
    note_count: notes.length,
    tag_count: out.tags.length,
    notes: notes.map((n) => ({
      id: n.id,
      category: n.category,
      statement: n.statement,
      evidence: String(n.evidence_from_input || "").slice(0, 200)
    })),
    tags: out.tags
  });
  return out;
}

// REMOVED: applyConstraintFilter, validateConcreteCandidates.
// Constraints are now context notes (annotations only). Concrete vs family
// no longer exists as a binary. See extractDecisionContext above.

async function filterPromotedByRelevance({ context, knowledgeMap, outDir, flags }) {
  if (flags && flags["skip-relevance-filter"]) {
    return { knowledgeMap, dropped: [], skipped: true };
  }
  const promoted = toArray(knowledgeMap?.candidates);
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
        `The decision being made is: "${context.decision}".`,
        `Domain: "${context.domain}".`,
        "",
        "You receive a list of architecture-family candidates surfaced from the",
        "live evidence pool. For each candidate, decide whether it is a",
        "plausible ANSWER to the decision being made.",
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
  const movedToOffTopic = promoted
    .filter((c) => droppedSet.has(slugify(c.name)))
    .map((c) => ({
      ...c,
      off_topic_for_decision: true,
      off_topic_reason: dropped.find((d) => slugify(d.name) === slugify(c.name))?.reason || ""
    }));

  // Persist off-topic drops across downstream knowledge-map rebuilds. The
  // adversarial cycle in compareTopologiesPhase calls buildKnowledgeMap
  // again on enriched evidence; without this set the dropped candidate gets
  // re-promoted from the same evidence the filter just rejected.
  const priorOffTopic = toArray(knowledgeMap._off_topic_drops);
  const offTopicNames = [
    ...new Set([...priorOffTopic, ...dropped.map((d) => slugify(d.name))])
  ];

  const updated = {
    ...knowledgeMap,
    candidates: keptPromoted,
    off_topic_candidates: [
      ...toArray(knowledgeMap.off_topic_candidates),
      ...movedToOffTopic
    ],
    _off_topic_drops: offTopicNames
  };

  await appendEvent(outDir, "candidate_relevance_filter_completed", {
    candidates_kept: keptPromoted.length,
    candidates_dropped: dropped.length,
    dropped_names: dropped.map((d) => d.name)
  });

  return { knowledgeMap: updated, dropped, skipped: false };
}

async function executeResearchPhase({ plan, context, outDir, flags }) {
  // --resume: skip the expensive research phase when a prior run already
  // produced evidence.json. The matrix / synthesis / critique stages all
  // re-run (cheap relative to web search + per-source claim extraction).
  // This is the biggest cost-saver in the resume flow — a typical run
  // does 60-80% of its LLM calls during research.
  if (flags && flags.resume) {
    try {
      const cachedEvidence = JSON.parse(
        await readFile(path.join(outDir, "evidence.json"), "utf8")
      );
      if (Array.isArray(cachedEvidence) && cachedEvidence.length > 0) {
        const knowledgeMap = buildKnowledgeMap(cachedEvidence);
        await writeJson(path.join(outDir, "knowledge-map.json"), knowledgeMap);
        await appendEvent(outDir, "research_resumed_from_cache", {
          evidence_count: cachedEvidence.length,
          candidate_count: knowledgeMap.candidates.length,
          reason: "Skipping research phase — evidence.json already present from prior run."
        });
        // Synthesize stub researchResults so downstream stages that read
        // .report don't break. Reports get re-generated by the matrix +
        // adversarial stages anyway.
        const researchResults = (plan.tasks || []).map((task) => ({
          task,
          evidence: [],
          report: `(resumed) Evidence loaded from cache; see evidence.json.`,
          rounds: 0,
          completionReason: "resumed_from_cache"
        }));
        return {
          researchResults,
          evidenceItems: cachedEvidence,
          knowledgeMap,
          adaptiveCycle: 0
        };
      }
    } catch {
      // No cached evidence — fall through and run research normally.
    }
  }

  let researchResults = await runResearchAgents({ plan, context, flags, outDir });
  let evidenceItems = assignCitations(
    researchResults.flatMap((result) => result.evidence)
  );
  let knowledgeMap = buildKnowledgeMap(evidenceItems);

  const maxAdaptiveCycles = Math.max(
    0,
    Number(flags["max-adaptive-cycles"] ?? 1)
  );
  let adaptiveCycle = 0;

  while (
    knowledgeMap.candidates.length === 0 &&
    adaptiveCycle < maxAdaptiveCycles
  ) {
    adaptiveCycle += 1;
    await appendEvent(outDir, "adaptive_research_cycle_started", {
      cycle: adaptiveCycle,
      reason: "no_candidates_surfaced",
      evidence_count: evidenceItems.length,
      off_topic_candidate_count: toArray(knowledgeMap.off_topic_candidates).length
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
      candidate_count: knowledgeMap.candidates.length
    });
  }

  await writeJson(path.join(outDir, "evidence.json"), evidenceItems);
  await writeJson(path.join(outDir, "knowledge-map.json"), knowledgeMap);
  await writeFile(
    path.join(outDir, "intermediate-reports.md"),
    researchResults.map((result) => result.report).join("\n")
  );
  // Running cost tally — after the expensive research phase the operator
  // can see "we've spent ~$X so far, with synthesis + audits still ahead".
  const costSoFar = summarizeLlmCost();
  await appendEvent(outDir, "cost_progress", {
    stage: "research_completed",
    usd_so_far: costSoFar.totals.estimated_usd,
    calls_so_far: costSoFar.totals.calls
  });

  await appendEvent(outDir, "evidence_collected", {
    evidence_count: evidenceItems.length,
    candidate_count: knowledgeMap.candidates.length,
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
    Number(flags["max-adversarial-cycles"] ?? 1)
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
    // Carry the relevance filter's off_topic verdict across the rebuild.
    // Without this, a candidate the filter dropped before adversarial
    // research can re-promote off the same evidence (issue 08).
    const stickyOffTopic = new Set(toArray(updatedKnowledgeMap._off_topic_drops));
    updatedKnowledgeMap = buildKnowledgeMap(updatedEvidenceItems, {
      offTopicNames: stickyOffTopic
    });
    if (stickyOffTopic.size > 0) {
      updatedKnowledgeMap._off_topic_drops = [...stickyOffTopic];
    }

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
  priorSpec = null,
  outDir = null
}) {
  return synthesizeResearchReport({
    context,
    knowledgeMap,
    evidenceItems,
    comparisonMatrix,
    priorCritique,
    priorSpec,
    outDir
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
      label: "research_report_critique_agent",
      system: [
        "You are the Architecture Deep Research critique agent.",
        "",
        "ADR produces a RESEARCH REPORT on the architectural decision space. Your",
        "job is to critique the report's comprehensiveness and grounding — NOT",
        "to pick a winner among the candidates.",
        "",
        "Focus on these failure modes:",
        "  1. missing_candidate_section: a candidate appeared in",
        "     knowledge_map.candidates but no entry exists in spec.options[].",
        "  2. imbalanced_evidence_depth: wide disparity in evidence depth across",
        "     candidates (e.g. one thick, three thin) that the executive_summary",
        "     and option_space_shape do not acknowledge. The report should",
        "     surface depth disparity so the reader weights confidence.",
        "  3. missing_cross_cutting_tradeoff: a matrix axis shows high variance",
        "     (candidates split strong vs weak) but no entry appears in",
        "     cross_cutting_tradeoffs.",
        "  4. weak_citation: a claim is cited but the source is low-quality —",
        "     general_web without corroboration, no official_docs / mature_oss /",
        "     paper_or_benchmark backing.",
        "  5. missing_open_question: a candidate's what_evidence_does_not_show",
        "     is non-empty but nothing relevant lands in open_questions.",
        "  6. unbalanced_per_option: when_to_pick and when_not_to_pick lists are",
        "     wildly different lengths (e.g. 4 pick / 0 avoid) suggesting bias.",
        "  7. citation_mismatch: a citation attached to candidate X actually",
        "     discusses a different candidate (the bleed pathology — citations",
        "     57, 58 are about OAuth but appear under token_based_auth).",
        "",
        "Severity:",
        "  - high: would mislead a reader (missing candidate section, citation",
        "    bleed, imbalanced depth left unacknowledged)",
        "  - medium: weakens the report but not load-bearing (thin when_to_pick,",
        "    one weak citation in an otherwise solid section)",
        "  - low: nice-to-have polish",
        "",
        "Cite evidence by citation_id. Be specific — \"citation 57 mentions OAuth",
        "client credentials, not token-based auth\" beats \"weak citation.\"",
        "",
        "Output JSON: {issues:[{severity, category, description, evidence_citations:[number], target:{kind:'option'|'report'|'tradeoff', name?:string}}], summary:string, recommend_human_review:boolean}.",
        "",
        "Set recommend_human_review:true only when the report is structurally",
        "unreliable — multiple missing candidate sections, citation bleed",
        "everywhere, depth disparity that invalidates the comparison."
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
  for (const opt of toArray(spec.options)) {
    for (const id of toArray(opt.citations).map(Number)) {
      if (Number.isFinite(id)) {
        citedPoints.push({
          citation_id: id,
          claim_context: `candidate:${opt.name}`,
          claim_text: `${opt.label || opt.name} — ${opt.summary || ""}; what evidence shows: ${(opt.what_evidence_shows || "").slice(0, 400)}`
        });
      }
    }
  }

  const items = [];

  // Auto-flag private_corpus items cited as evidence for an external option
  // before the LLM auditor sees them. private_corpus describes team context,
  // not external evidence — it cannot support a candidate's external
  // properties. Cheaper than an LLM call and 100% reliable. Synthesis is
  // already supposed to filter these, but this is the final backstop.
  const autoFlaggedPoints = new Set();
  for (let i = citedPoints.length - 1; i >= 0; i -= 1) {
    const point = citedPoints[i];
    const item = evidenceById.get(Number(point.citation_id));
    if (!item) continue;
    if (item.source_type !== "private_corpus") continue;
    if (!/^candidate:/.test(point.claim_context)) continue;
    items.push({
      citation_id: point.citation_id,
      claim_context: point.claim_context,
      verified: false,
      confidence: 0,
      reason: "private_corpus cannot serve as external evidence for a candidate claim",
      evidence_present: true,
      auto_flagged: true
    });
    autoFlaggedPoints.add(`${point.citation_id}|${point.claim_context}`);
    citedPoints.splice(i, 1);
  }
  if (autoFlaggedPoints.size > 0) {
    await appendEvent(outDir, "citation_audit_auto_flagged_private_corpus", {
      count: autoFlaggedPoints.size
    });
  }

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
  // Count how many of the audited citations came from community-discussion
  // sources (Reddit, HN, Twitter, Stack Exchange). Surfaced so a run that
  // leans heavily on practitioner signal is visible to the reader.
  const communitySourceCount = toArray(audit.items).filter((i) => {
    const ev = evidenceById.get(Number(i.citation_id));
    return ev && ev.source_type === "community_discussion";
  }).length;
  await appendEvent(outDir, "citation_audit_completed", {
    total_citations: totalCitations,
    verified_count: verifiedCount,
    unsupported_count: unsupportedCount,
    community_source_count: communitySourceCount,
    unsupported_details: unsupportedDetails
  });
  return audit;
}

// ADR is a research-report engine now. There is no recommendation to drop —
// the critique surfaces report quality issues, and the citation audit
// surfaces unsupported claims, but neither rewrites the spec. The reader
// weighs the audit results and the per-candidate evidence themselves.
//
// applyCritique and applyCitationAudit are preserved as no-ops so existing
// callers (and any framework adapters) continue to work without changes.
function applyCritique({ spec, critique, flags }) {
  // critique and flags are surfaced via critique.json + state.json; this
  // function does not mutate the spec.
  void critique;
  void flags;
  return { spec, downgraded: false };
}

function applyCitationAudit({ spec, citationAudit, flags }) {
  // citationAudit results are surfaced via citation-audit.json + state.json;
  // this function does not mutate the spec.
  void citationAudit;
  void flags;
  return { spec, downgraded: false, unsupportedSelected: [] };
}

// Compute per-axis verdict variance ("spread") across candidates in the
// comparison matrix. Higher spread = the axis genuinely discriminates
// options and is a good candidate for a sharper follow-up sub-decision.
function computeAxisSpread(matrix) {
  if (!matrix || !Array.isArray(matrix.cells) || !Array.isArray(matrix.axes)) return [];
  // Weight verdicts so insufficient_evidence and no_evidence count as the
  // same "uncertain" signal; strong/weak are the two opinionated ends.
  const verdictValue = (v) => {
    if (v === "strong") return 1;
    if (v === "weak") return -1;
    if (v === "mixed") return 0;
    return null; // no_evidence / insufficient_evidence / empty
  };
  const cellsByAxis = new Map();
  for (const cell of matrix.cells) {
    const axisId = cell.axis;
    if (!cellsByAxis.has(axisId)) cellsByAxis.set(axisId, []);
    cellsByAxis.get(axisId).push(cell);
  }
  const spreads = [];
  for (const axis of matrix.axes) {
    const cells = cellsByAxis.get(axis.id) || [];
    if (cells.length < 2) continue;
    const values = cells.map((c) => verdictValue(c.verdict));
    const known = values.filter((v) => v !== null);
    const unknownCount = values.length - known.length;
    let score;
    if (known.length === 0) {
      // Every cell is no_evidence — high uncertainty, surface as a follow-up.
      score = 0.6 + Math.min(unknownCount / 10, 0.3);
    } else {
      const mean = known.reduce((s, v) => s + v, 0) / known.length;
      const variance =
        known.reduce((s, v) => s + (v - mean) * (v - mean), 0) / known.length;
      const std = Math.sqrt(variance); // 0..1 for our verdict scale
      const unknownPenalty = unknownCount / values.length;
      score = std + 0.3 * unknownPenalty;
    }
    spreads.push({
      axis_id: axis.id,
      axis_label: axis.label,
      spread_score: Number(score.toFixed(3)),
      cell_count: cells.length,
      unknown_count: unknownCount
    });
  }
  return spreads.sort((a, b) => b.spread_score - a.spread_score);
}

// Propose 2-3 sharper sub-decision questions based on matrix axis variance.
// Runs AFTER the citation audit and BEFORE the handoff write. Persisted as
// follow-up-questions.json and appended to ADR.md as "## Follow-up Questions".
async function proposeFollowUpQuestions({ context, spec, comparisonMatrix, outDir }) {
  const options = toArray(spec?.options);
  if (options.length === 0 || !comparisonMatrix) {
    const empty = {
      version: VERSION,
      decision: context.decision,
      domain: context.domain,
      generated_at: nowIso(),
      follow_ups: []
    };
    await writeJson(path.join(outDir, "follow-up-questions.json"), empty);
    await appendEvent(outDir, "follow_up_questions_proposed", { count: 0, axes: [] });
    return empty;
  }

  const spreads = computeAxisSpread(comparisonMatrix).slice(0, 3);
  if (spreads.length === 0) {
    const empty = {
      version: VERSION,
      decision: context.decision,
      domain: context.domain,
      generated_at: nowIso(),
      follow_ups: []
    };
    await writeJson(path.join(outDir, "follow-up-questions.json"), empty);
    await appendEvent(outDir, "follow_up_questions_proposed", { count: 0, axes: [] });
    return empty;
  }

  let raw;
  try {
    raw = await callLlmJson({
      label: "follow_up_question_proposer",
      system: [
        "You propose research threads that would deepen the evidence on the highest-spread axes from this run.",
        "",
        "The main run produced a research report mapping the option space. For",
        "each high-spread axis below — where candidates landed at different",
        "verdicts, suggesting the evidence is thinner than the headline suggests",
        "— write a concise question framing the next RESEARCH DIG (not the next",
        "decision), plus a pre-filled `adr deep-research` command the user can",
        "paste to chase it.",
        "",
        "For each input axis emit:",
        "  axis: the axis id from the input",
        "  spread_score: the input spread score, unchanged",
        "  question: 1 sentence, sharp, names the research thread (e.g., 'Dig deeper on managed-vs-self-hosted operational tradeoffs for graph stores — current evidence is thin on production outages and recovery.')",
        "  suggested_command: a complete `adr deep-research --decision '...' --domain '...' --out .adr-runs/<slug>` command. Use a short slug.",
        "",
        "Keep questions grounded in the candidates the matrix actually contains.",
        "Do not invent vendors. The question deepens evidence on this axis; it",
        "is not a sub-decision the reader must make.",
        "",
        "Output JSON: { follow_ups: [{ axis, spread_score, question, suggested_command }] }."
      ].join("\n"),
      user: JSON.stringify({
        parent_decision: context.decision,
        parent_domain: context.domain,
        options: options.map((o) => ({
          name: o.name,
          label: o.label,
          strong_axes: o.strong_axes,
          weak_axes: o.weak_axes,
          evidence_depth: o.evidence_depth
        })),
        high_spread_axes: spreads,
        matrix_axes: (comparisonMatrix.axes || []).map((a) => ({ id: a.id, label: a.label }))
      })
    });
  } catch (error) {
    await appendEvent(outDir, "follow_up_questions_failed", {
      error: String(error?.message || error)
    });
    const empty = {
      version: VERSION,
      decision: context.decision,
      domain: context.domain,
      generated_at: nowIso(),
      follow_ups: []
    };
    await writeJson(path.join(outDir, "follow-up-questions.json"), empty);
    return empty;
  }

  const spreadByAxis = new Map(spreads.map((s) => [s.axis_id, s]));
  const followUps = toArray(raw.follow_ups)
    .map((f) => {
      if (!f || typeof f !== "object") return null;
      const axis = String(f.axis || "").trim();
      const question = String(f.question || "").trim();
      const suggested = String(f.suggested_command || "").trim();
      if (!axis || !question) return null;
      const spread = spreadByAxis.get(axis);
      return {
        axis,
        spread_score: spread
          ? spread.spread_score
          : clampNumber(f.spread_score, { min: 0, max: 2, fallback: 0 }),
        question,
        suggested_command: suggested
      };
    })
    .filter(Boolean)
    .slice(0, 3);

  const artifact = {
    version: VERSION,
    decision: context.decision,
    domain: context.domain,
    generated_at: nowIso(),
    follow_ups: followUps
  };
  await writeJson(path.join(outDir, "follow-up-questions.json"), artifact);
  await appendEvent(outDir, "follow_up_questions_proposed", {
    count: followUps.length,
    axes: followUps.map((f) => f.axis)
  });
  return artifact;
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
  followUps = null,
  flags = {}
}) {
  // The handoff stage (agent-guardrails.md + execution-handoff.json +
  // domain-evaluation-pack.json) is now lazy. It runs on `adr handoff
  // <out_dir> --option <name>`, NOT on the default pipeline. ADR's job is
  // to produce a research report; the handoff is a downstream artifact the
  // reader requests after they pick a candidate.
  const wantHandoff = Boolean(flags["write-handoff"]);

  const report = buildResearchReportMarkdown({
    context,
    plan,
    spec,
    evidenceItems,
    researchResults,
    knowledgeMap
  });
  const costSummary = summarizeLlmCost();
  const runMetadata = {
    generated_at: nowIso(),
    estimated_usd: costSummary.totals.estimated_usd,
    total_llm_calls: costSummary.totals.calls
  };
  const baseAdrMarkdown = buildADR(context, spec, knowledgeMap, evidenceItems, runMetadata);
  const followUpsSection = (followUps && toArray(followUps.follow_ups).length > 0)
    ? `\n## Where to Dig Deeper\n\nThe matrix surfaced these axes as the thinnest in this run. Each one is a sharper research thread to chase next; the suggested command pre-fills \`adr deep-research\` for you.\n\n${toArray(followUps.follow_ups).map((f, i) => `### ${i + 1}. ${f.question}\n\n*Axis:* \`${f.axis}\` (spread ${f.spread_score})\n\n${f.suggested_command ? "```bash\n" + f.suggested_command + "\n```" : "_(no suggested command)_"}`).join("\n\n")}\n`
    : "";
  const adrMarkdown = baseAdrMarkdown + followUpsSection;

  const claimAudit = flags["skip-claim-audit"]
    ? null
    : await scanUncitedClaimsPhase({
        context,
        spec,
        adrMarkdown,
        researchReport: report,
        evidenceItems,
        outDir
      });

  // Default-path artifacts: the research report (json + md), ADR.md, sources.md.
  // Handoff artifacts (guardrails, execution-handoff, domain-evaluation-pack)
  // are skipped unless --write-handoff was set.
  const validationWarnings = [];
  await writeFile(path.join(outDir, "ADR.md"), adrMarkdown);
  const specWrite = await writeJsonBestEffort(path.join(outDir, "research-report.json"), spec);
  if (!specWrite.ok) validationWarnings.push({ file: "research-report.json", error: specWrite.error });
  await writeFile(path.join(outDir, "research-report.md"), report);
  await writeFile(path.join(outDir, "sources.md"), buildDeepSources(context, evidenceItems));

  let evaluationPack = null;
  if (wantHandoff) {
    await appendEvent(outDir, "evaluation_pack_started", {});
    evaluationPack = await buildEvaluationPack(context, spec, evidenceItems, comparisonMatrix);
    await appendEvent(outDir, "evaluation_pack_completed", {
      test_case_count: evaluationPack.test_cases.length,
      metric_count: Object.keys(evaluationPack.metrics || {}).length
    });
    await appendEvent(outDir, "handoff_writing", {});
    const evalWrite = await writeJsonBestEffort(path.join(outDir, "domain-evaluation-pack.json"), evaluationPack);
    if (!evalWrite.ok) validationWarnings.push({ file: "domain-evaluation-pack.json", error: evalWrite.error });
    await writeFile(path.join(outDir, "agent-guardrails.md"), buildGuardrails(spec));
    const handoff = buildExecutionHandoff(spec);
    const handoffWrite = await writeJsonBestEffort(path.join(outDir, "execution-handoff.json"), handoff);
    if (!handoffWrite.ok) validationWarnings.push({ file: "execution-handoff.json", error: handoffWrite.error });
  } else {
    await appendEvent(outDir, "handoff_skipped", {
      reason: "default_pipeline_omits_handoff",
      hint: "Run `adr handoff <out_dir> --option <name>` to scope an implementation contract for one candidate."
    });
  }

  if (validationWarnings.length > 0) {
    await appendEvent(outDir, "artifact_validation_warnings", {
      warning_count: validationWarnings.length,
      files: validationWarnings.map((w) => w.file)
    });
  }
  await writeJson(path.join(outDir, "cost.json"), costSummary);
  const options = toArray(spec.options);
  await writeJson(path.join(outDir, "state.json"), {
    version: VERSION,
    status: "completed",
    completed_at: nowIso(),
    candidate_count: options.length,
    evidence_count: evidenceItems.length,
    critique_high_severity_count: critique ? critique.high_severity_count : 0,
    citation_audit_unsupported_count: citationAudit ? citationAudit.unsupported_count : 0,
    claim_audit_high_severity_count: claimAudit ? claimAudit.high_severity_count : 0,
    claim_audit_uncited_material_claim_count: claimAudit
      ? claimAudit.uncited_material_claim_count
      : 0,
    comparison_matrix_empty_cells: comparisonMatrix ? comparisonMatrix.empty_cells.length : 0,
    estimated_usd: costSummary.totals.estimated_usd,
    handoff_written: wantHandoff,
    handoff_boundary: "adr_stops_at_research_report"
  });
  await appendEvent(outDir, "run_completed", {
    candidate_count: options.length,
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
    options,
    candidateCount: options.length,
    evidenceCount: evidenceItems.length,
    handoffBoundary: "adr_stops_at_research_report",
    handoffWritten: wantHandoff,
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
        // Forward domain too so the discover stage can pass it to
        // peer-finder for better peer relevance.
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
  const plan = await planResearchPhase({
    context: prepared.context,
    content: prepared.content,
    outDir: prepared.outDir,
    flags
  });

  // Cost estimate after the plan is fixed. Writes cost-estimate.json next
  // to research-plan.json so the operator can read it before letting the
  // expensive stages run. Emits a cost_estimated event so streaming UIs
  // can surface "this run will cost ~$0.12".
  const peerTaskCount = toArray(plan.tasks).filter((t) => t.peer_target).length;
  const nonPeerTaskCount = toArray(plan.tasks).length - peerTaskCount;
  const estimateUsd = estimateRunCostUsd({
    task_count: nonPeerTaskCount,
    peer_task_count: peerTaskCount,
    include_discover: chainedFromDiscover,
    include_peers: Boolean(flags["include-peers"])
  });
  await writeFile(
    path.join(prepared.outDir, "cost-estimate.json"),
    JSON.stringify(
      {
        version: VERSION,
        estimated_at: nowIso(),
        task_count: toArray(plan.tasks).length,
        peer_task_count: peerTaskCount,
        estimated_usd: estimateUsd,
        confidence: "rough — actual ±30% based on PRD size, source pages, cycle count",
        profile: COST_PROFILE_USD
      },
      null,
      2
    )
  );
  await appendEvent(prepared.outDir, "cost_estimated", {
    task_count: toArray(plan.tasks).length,
    peer_task_count: peerTaskCount,
    estimated_usd: estimateUsd
  });

  // --dry-run short-circuit: print plan + estimate, do not spend tokens
  // on the expensive stages. Useful for budget sanity-check.
  if (flags["dry-run"]) {
    await writeJson(path.join(prepared.outDir, "state.json"), {
      version: VERSION,
      status: "dry_run_complete",
      completed_at: nowIso(),
      task_count: toArray(plan.tasks).length,
      estimated_usd: estimateUsd
    });
    await appendEvent(prepared.outDir, "dry_run_complete", {
      task_count: toArray(plan.tasks).length,
      estimated_usd: estimateUsd
    });
    console.log("");
    console.log(`Dry run: ${toArray(plan.tasks).length} tasks planned (${peerTaskCount} peer-targeted).`);
    console.log(`Estimated cost: ~$${estimateUsd.toFixed(4)} (rough, ±30%).`);
    console.log(`Plan written to ${path.join(prepared.outDir, "research-plan.json")}.`);
    console.log("Run without --dry-run to execute the research stages.");
    return {
      status: "dry_run_complete",
      out_dir: prepared.outDir,
      task_count: toArray(plan.tasks).length,
      estimated_usd: estimateUsd
    };
  }

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
      candidate_count: knowledgeMap.candidates.length,
      antipattern_axis_count: discoveredAntipatterns.length
    });
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
    candidates: knowledgeMap.candidates.length,
    evidence_count: evidenceItems.length
  });
  let rawSpec = await synthesizeDecisionPhase({
    context: prepared.context,
    knowledgeMap,
    evidenceItems,
    comparisonMatrix,
    outDir: prepared.outDir
  });
  // Concrete content: each candidate's name, label, 1-line summary, top
  // strong + weak axes, evidence depth, and pick-when reading aid. This is
  // the moment the user sees the report's per-candidate verdicts.
  const synthOptions = toArray(rawSpec.options).map((o) => ({
    name: o.name,
    label: o.label,
    summary: String(o.summary || "").slice(0, 200),
    evidence_depth: o.evidence_depth || "thin",
    strong_axes: toArray(o.strong_axes).slice(0, 4),
    weak_axes: toArray(o.weak_axes).slice(0, 4),
    when_to_pick: toArray(o.when_to_pick).slice(0, 2).map((s) => String(s).slice(0, 160))
  }));
  const synthCost = summarizeLlmCost();
  await appendEvent(prepared.outDir, "cost_progress", {
    stage: "synthesis_completed",
    usd_so_far: synthCost.totals.estimated_usd,
    calls_so_far: synthCost.totals.calls
  });

  await appendEvent(prepared.outDir, "synthesis_completed", {
    candidate_count: synthOptions.length,
    options: synthOptions
  });

  await appendEvent(prepared.outDir, "critique_started", {});
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
      original_high_severity_count: critique.high_severity_count
    });
    const resynthSpec = await synthesizeDecisionPhase({
      context: prepared.context,
      knowledgeMap,
      evidenceItems,
      comparisonMatrix,
      priorCritique: critique,
      priorSpec: rawSpec,
      outDir: prepared.outDir
    });
    // Persist the v1 report + critique for transparency; the active report
    // (whichever wins) keeps the canonical filename.
    await writeJson(path.join(prepared.outDir, "research-report.v1.json"), rawSpec);
    await writeJson(path.join(prepared.outDir, "critique.v1.json"), critique);
    await writeJson(path.join(prepared.outDir, "research-report.v2.json"), resynthSpec);

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
        new_high_severity_count: resynthCritique.high_severity_count
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

  // applyCritique / applyCitationAudit are no-ops in the report engine —
  // critique + citation results are surfaced to the reader via their own
  // artifacts; the report itself is not rewritten.
  const { spec: finalSpec } = applyCritique({ spec: rawSpec, critique, flags });
  const { spec: auditedSpec } = applyCitationAudit({
    spec: finalSpec,
    citationAudit,
    flags
  });

  // Follow-up question proposer — runs AFTER citation audit, BEFORE writing
  // artifacts. Looks at matrix axis variance, picks the top 2-3 axes, asks
  // the LLM to write a sharper research thread per axis. Persisted as
  // follow-up-questions.json; also appended to ADR.md under "Where to Dig
  // Deeper" by writeRunArtifacts.
  const followUps = await proposeFollowUpQuestions({
    context: prepared.context,
    spec: auditedSpec,
    comparisonMatrix,
    outDir: prepared.outDir
  });

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
    followUps,
    flags
  });

  console.log(`Research report written to ${prepared.outDir}`);
  if (result.candidateCount > 0) {
    console.log(
      `Candidates: ${result.candidateCount} in the option space — see ADR.md for per-candidate sections`
    );
    console.log(
      `  ${result.options.map((o) => o.name).join(" · ")}`
    );
  } else {
    console.log("No candidates surfaced — see critique.json and re-run with sharper context.");
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
  console.log("Boundary: ADR stops at the research report. Run `adr handoff <out_dir> --option <name>` for an implementation contract.");

  return {
    status: "completed",
    out_dir: prepared.outDir,
    candidate_count: result.candidateCount
  };
}

async function supersedeAdr({ previousDir, inputPath, flags }) {
  if (!previousDir) {
    throw new Error("Usage: adr supersede <previous-output-dir> --with <product-context.md> --domain <domain> --decision <decision> --out <dir>");
  }
  const previousSpecPath = path.join(path.resolve(previousDir), "research-report.json");
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
  const nextSpec = JSON.parse(await readFile(path.join(outDir, "research-report.json"), "utf8"));
  const supersedes = {
    version: VERSION,
    previous_decision_id: previousSpec.id,
    previous_candidates: toArray(previousSpec.options).map((o) => o.name),
    new_decision_id: nextSpec.id,
    new_candidates: toArray(nextSpec.options).map((o) => o.name),
    reason: flags.reason || "Superseding research report generated from a new live ADR run.",
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

This report supersedes ${supersedes.previous_decision_id || "the previous report"} from \`${previousDir}\`.

- Previous candidates: ${supersedes.previous_candidates.join(", ") || "unknown"}
- New candidates: ${supersedes.new_candidates.join(", ") || "unknown"}
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

// `discoverPrinciples` lives in src/principles/index.mjs. Same lazy-import
// pattern as discoverPatterns to avoid a circular import — the principles
// modules re-enter this kernel for callLlmJson / appendEvent / writeJson.
async function discoverPrinciples(input) {
  const mod = await import("./principles/index.mjs");
  return mod.discoverPrinciples(input);
}

// `reviewDiff` lives in src/review/index.mjs. Same lazy-import pattern.
async function reviewDiff(input) {
  const mod = await import("./review/index.mjs");
  return mod.reviewDiff(input);
}

// `guard` lives in src/guard/index.mjs. Same lazy-import pattern.
async function guard(input) {
  const mod = await import("./guard/index.mjs");
  return mod.guard(input);
}

// generateHandoff is the lazy handoff stage. The default pipeline produces
// only the research report; this command reads research-report.json from
// an existing run dir, scopes to one chosen candidate, and writes the
// implementation contract: agent-guardrails.md + execution-handoff.json,
// optionally plus domain-evaluation-pack.json.
async function generateHandoff({ outDir, optionName, flags = {} }) {
  if (!outDir) {
    throw new Error("Usage: adr handoff <out_dir> --option <candidate-name> [--write-evaluation-pack]");
  }
  if (!optionName) {
    throw new Error(
      "adr handoff requires --option <candidate-name>. Run with the name of a candidate from research-report.json's options[]."
    );
  }
  const resolved = path.resolve(outDir);
  const reportPath = path.join(resolved, "research-report.json");
  let spec;
  try {
    spec = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `No research-report.json in ${resolved}. Run \`adr deep-research\` first to produce the report.`
      );
    }
    throw error;
  }

  const reportOptions = toArray(spec.options);
  const targetSlug = slugify(String(optionName).trim());
  const chosen = reportOptions.find((o) => slugify(o.name) === targetSlug);
  if (!chosen) {
    const names = reportOptions.map((o) => o.name).join(", ") || "(none)";
    throw new Error(
      `Option "${optionName}" not found in research-report.json. Available: ${names}`
    );
  }

  await appendEvent(resolved, "handoff_started", {
    chosen_option: chosen.name
  });

  // Load context + evidence + matrix lazily; the evaluation pack needs them.
  const writeEvaluationPack = Boolean(flags["write-evaluation-pack"]);
  let evaluationPack = null;
  if (writeEvaluationPack) {
    let context = null;
    let evidence = [];
    let matrix = null;
    try {
      context = JSON.parse(await readFile(path.join(resolved, "strategic-context.json"), "utf8"));
    } catch {
      // strategic-context.json is required for evaluation pack; bail clean.
      throw new Error(
        `Cannot write evaluation pack: strategic-context.json missing in ${resolved}. Re-run the full pipeline.`
      );
    }
    try {
      evidence = JSON.parse(await readFile(path.join(resolved, "evidence.json"), "utf8"));
    } catch {
      // empty evidence is allowed
    }
    try {
      matrix = JSON.parse(await readFile(path.join(resolved, "comparison-matrix.json"), "utf8"));
    } catch {
      // matrix is optional
    }
    evaluationPack = await buildEvaluationPack(context, spec, evidence, matrix, {
      targetOptionName: chosen.name
    });
    await writeJsonBestEffort(path.join(resolved, "domain-evaluation-pack.json"), evaluationPack);
  }

  const handoff = buildExecutionHandoff(spec, { targetOptionName: chosen.name });
  await writeJsonBestEffort(path.join(resolved, "execution-handoff.json"), handoff);
  await writeFile(
    path.join(resolved, "agent-guardrails.md"),
    buildGuardrails(spec, { targetOptionName: chosen.name })
  );

  await appendEvent(resolved, "handoff_completed", {
    chosen_option: chosen.name,
    wrote_evaluation_pack: writeEvaluationPack
  });

  console.log(`Handoff written to ${resolved}`);
  console.log(`  Option: ${chosen.name} — ${chosen.label}`);
  console.log(`  agent-guardrails.md ✓`);
  console.log(`  execution-handoff.json ✓`);
  if (writeEvaluationPack) {
    console.log(`  domain-evaluation-pack.json ✓`);
  }
  return {
    status: "completed",
    out_dir: resolved,
    chosen_option: chosen.name,
    wrote_evaluation_pack: writeEvaluationPack
  };
}

export {
  VERSION,
  applyCitationAudit,
  activeLlmProvider,
  activeSearchProviders,
  appendEvent,
  applyCritique,
  assessClarification,
  buildAdaptiveResearchPlan,
  buildADR,
  buildAdversarialResearchPlan,
  buildComparisonMatrix,
  buildEvaluationPack,
  buildExecutionHandoff,
  buildGuardrails,
  buildKnowledgeMap,
  buildPeerResearchTasks,
  buildResearchPlan,
  buildStrategicContext,
  callLlmJson,
  classifyCommunityPlatform,
  classifySource,
  extractCommunityPlatformDetails,
  compareTopologiesPhase,
  critiqueDecisionPhase,
  deepResearch,
  deriveComparisonAxes,
  digestPaper,
  discoverPatterns,
  discoverPrinciples,
  executeResearchPhase,
  extractClaims,
  extractDecisionContext,
  filterPromotedByRelevance,
  generateHandoff,
  guard,
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
  proposeFollowUpQuestions,
  research,
  resetLlmCost,
  reviewDiff,
  runResearchAgents,
  searchWithProvider,
  setLlmJsonProvider,
  summarizeLlmCost,
  supersedeAdr,
  synthesizeDecisionPhase,
  synthesizeResearchReport,
  validateMermaidSource,
  verifyCitationsPhase,
  writeJson,
  writeRunArtifacts
};
