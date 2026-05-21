import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION = "0.2.0";
const MAX_PARALLEL_RESEARCH_AGENTS = 3;

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

  const candidates = toArray(result.candidate_topologies).map((candidate) => ({
    name: candidate.name || slugify(candidate.label || "unknown"),
    label: candidate.label || titleCase(candidate.name || "unknown"),
    fit: candidate.fit || "",
    risks: toArray(candidate.risks),
    decision: candidate.decision || (candidate.name === selected ? "selected" : "rejected"),
    evidence_citations: toArray(candidate.evidence_citations),
    confidence: Math.max(0, Math.min(1, Number(candidate.confidence || 0.5)))
  }));
  if (!candidates.some((candidate) => candidate.decision === "selected")) {
    candidates.unshift({
      name: selected,
      label: titleCase(selected),
      fit: result.decision?.summary || "Selected by the architecture synthesis agent.",
      risks: [],
      decision: "selected",
      evidence_citations: toArray(result.decision?.evidence_citations),
      confidence: 0.5
    });
  }

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
      "No live search provider configured. Set BRAVE_SEARCH_API_KEY, SERPER_API_KEY, TAVILY_API_KEY, or SEARXNG_URL before running Architecture Deep Research."
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

async function searchWithProvider(query) {
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

function extractExcerpt(text, keywords) {
  const clean = normalizeWhitespace(text).slice(0, 60_000);
  const lower = clean.toLowerCase();
  const keyword = keywords.find((item) => lower.includes(String(item).toLowerCase()));
  if (!keyword) return clean.slice(0, 1200);
  const index = Math.max(0, lower.indexOf(String(keyword).toLowerCase()) - 400);
  return clean.slice(index, index + 1600);
}

function classifySource(url) {
  if (!url) return "unknown";
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
      : claims.reduce((sum, claim) => sum + Number(claim.confidence || 0), 0) / claims.length;
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

async function extractClaims({ context, task, source }) {  const result = await callLlmJson({
    label: "source_claim_extractor",
    system: [
      "You extract architecture-decision evidence from sources.",
      "Return only claims that are directly supported by the supplied excerpt.",
      "Do not add static architecture knowledge.",
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
      polarity: String(claim.polarity || "neutral").trim(),
      domain_conditions: toArray(claim.domain_conditions).map(String).slice(0, 6),
      risk_or_fit: String(claim.risk_or_fit || "").trim(),
      confidence: Math.max(0, Math.min(1, Number(claim.confidence || 0.5)))
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
  maxSources
}) {
  const results = await searchWithProvider(query);
  for (const result of results) {
    if (!result.url || seenUrls.has(result.url)) continue;
    seenUrls.add(result.url);

    const source_type = classifySource(result.url);
    const opened = await openUrl(result.url, flags).catch(() => "");
    const sourceText = opened || result.snippet || "";
    const excerpt = extractExcerpt(sourceText, keywords);
    if (!excerpt || excerpt.length < 120) continue;

    const partial = {
      task_id: task.id,
      title: result.title || result.url,
      url: result.url,
      provider: result.provider,
      query,
      excerpt,
      source_type,
      source_quality: sourceQuality(source_type),
      relevance: task.objective
    };
    const claims = await extractClaims({ context, task, source: partial });
    const scored = scoreEvidence({ sourceType: source_type, excerpt, context, task, claims });

    evidence.push({
      ...partial,
      round,
      claims,
      keyword_hits: scored.keyword_hits,
      score: scored.score
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
        maxSources
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
    .sort((a, b) => b.score - a.score)
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
        confidence: claim.confidence,
        source_type: item.source_type,
        url: item.url
      };

      if (claim.polarity === "supports") existing.support.push(record);
      else if (claim.polarity === "rejects") existing.rejections.push(record);
      else existing.warnings.push(record);

      existing.source_types.add(item.source_type);
      existing.citations.add(item.citation_id);
      existing.score_total += item.score * claim.confidence;
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
        sourceTypes.includes("paper_or_benchmark"));

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
      score: Number(item.score_total.toFixed(3))
    };
  });

  return {
    version: VERSION,
    acquisition_mode: "evidence_only_live_research",
    promotion_rule:
      "Architecture families are promoted only from extracted claims with cited live-source evidence. Static seed hypotheses are not allowed.",
    promoted_candidates: patterns.filter((item) => item.promotion_status === "evidence_backed_candidate"),
    insufficient_evidence_candidates: patterns.filter((item) => item.promotion_status !== "evidence_backed_candidate")
  };
}

async function synthesizeArchitectureSpec({ context, knowledgeMap, evidenceItems }) {
  const result = await callLlmJson({
    label: "architecture_synthesis_agent",
    system: [
      "You are the Architecture Deep Research synthesis agent.",
      "Choose an architecture family only from evidence-backed research claims.",
      "If evidence is insufficient, select requires_human_architecture_review.",
      "Do not use a static pattern library.",
      "Do not implement the product.",
      "Output JSON with {decision, domain_model, candidate_topologies, guardrails, evidence_summary}.",
      "candidate_topologies items need {name,label,fit,risks,decision,evidence_citations,confidence}.",
      "guardrails needs {forbidden_topologies,required_invariants,allowed_agentic_use,enforcement_notes}."
    ].join("\n"),
    user: JSON.stringify({
      context,
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

  const selected = result.decision?.selected_topology || "requires_human_architecture_review";
  return {
    version: VERSION,
    decision: {
      id: result.decision?.id || "ADR-001",
      title: result.decision?.title || titleCase(context.decision),
      status: result.decision?.status || "proposed",
      selected_topology: selected,
      summary:
        result.decision?.summary ||
        "Architecture decision synthesized from live evidence acquisition.",
      evidence_citations: toArray(result.decision?.evidence_citations)
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
    metrics: result.metrics || {
      deterministic_lineage_rate: { target: 0.98 },
      boundary_spill_tolerance: { target: 0 },
      unsupported_answer_rate: { target: 0 },
      p95_latency_ms: { target: 2500 }
    },
    test_cases: normalizeEvaluationCases(result.test_cases, context, spec).slice(0, 12)
  };
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

function buildDeepSources(context, evidenceItems) {
  const cited = evidenceItems
    .map(
      (item) =>
        `- [${item.citation_id}] ${item.title} (${item.url}) - ${item.source_type}; score ${item.score}`
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

async function synthesizeDecisionPhase({ context, knowledgeMap, evidenceItems }) {
  return synthesizeArchitectureSpec({ context, knowledgeMap, evidenceItems });
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
        "evidence weaknesses (single source, low quality, no official_docs or mature_oss or paper_or_benchmark backing);",
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
      issues: [],
      summary: `critique_failed: ${String(error?.message || error)}`,
      recommend_human_review: false
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

function applyCritique({ spec, critique, flags }) {
  if (!critique) return { spec, downgraded: false };
  if (!flags["enforce-critique"]) return { spec, downgraded: false };
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

async function writeRunArtifacts({
  context,
  plan,
  spec,
  evidenceItems,
  researchResults,
  knowledgeMap,
  outDir,
  critique
}) {
  const evaluationPack = await buildEvaluationPack(context, spec, evidenceItems);
  const baseHandoff = buildExecutionHandoff(spec);
  const handoff = critique
    ? {
        ...baseHandoff,
        artifacts: { ...baseHandoff.artifacts, critique: "critique.json" },
        critique_summary: {
          issue_count: critique.issues.length,
          high_severity_count: critique.high_severity_count,
          recommend_human_review: critique.recommend_human_review
        }
      }
    : baseHandoff;
  const report = synthesizeResearchReport({
    context,
    plan,
    spec,
    evidenceItems,
    researchResults,
    knowledgeMap
  });

  await writeFile(path.join(outDir, "ADR.md"), buildADR(context, spec, knowledgeMap));
  await writeJson(path.join(outDir, "architecture.spec.json"), spec);
  await writeJson(path.join(outDir, "domain-evaluation-pack.json"), evaluationPack);
  await writeFile(path.join(outDir, "agent-guardrails.md"), buildGuardrails(spec));
  await writeJson(path.join(outDir, "execution-handoff.json"), handoff);
  await writeFile(path.join(outDir, "research-report.md"), report);
  await writeFile(path.join(outDir, "sources.md"), buildDeepSources(context, evidenceItems));
  await writeJson(path.join(outDir, "state.json"), {
    version: VERSION,
    status: "completed",
    completed_at: nowIso(),
    selected_topology: spec.decision.selected_topology,
    original_selected_topology: spec.decision.original_selected_topology || null,
    evidence_count: evidenceItems.length,
    promoted_candidate_count: knowledgeMap.promoted_candidates.length,
    critique_high_severity_count: critique ? critique.high_severity_count : 0,
    handoff_boundary: "adr_stops_at_execution_handoff"
  });
  await appendEvent(outDir, "run_completed", {
    selected_topology: spec.decision.selected_topology,
    evidence_count: evidenceItems.length,
    critique_high_severity_count: critique ? critique.high_severity_count : 0
  });

  return {
    selectedTopology: spec.decision.selected_topology,
    evidenceCount: evidenceItems.length,
    promotedCandidateCount: knowledgeMap.promoted_candidates.length,
    handoffBoundary: "adr_stops_at_execution_handoff",
    critiqueHighSeverityCount: critique ? critique.high_severity_count : 0
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

  const { researchResults, evidenceItems, knowledgeMap } = await executeResearchPhase({
    plan,
    context: prepared.context,
    outDir: prepared.outDir,
    flags
  });

  const rawSpec = await synthesizeDecisionPhase({
    context: prepared.context,
    knowledgeMap,
    evidenceItems
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

  const { spec: finalSpec, downgraded } = applyCritique({
    spec: rawSpec,
    critique,
    flags
  });
  if (downgraded) {
    await appendEvent(prepared.outDir, "decision_downgraded_by_critique", {
      original_selected_topology: finalSpec.decision.original_selected_topology,
      high_severity_count: critique.high_severity_count
    });
  }

  const result = await writeRunArtifacts({
    context: prepared.context,
    plan,
    spec: finalSpec,
    evidenceItems,
    researchResults,
    knowledgeMap,
    outDir: prepared.outDir,
    critique
  });

  console.log(`Deep research artifacts written to ${prepared.outDir}`);
  console.log(`Selected topology: ${result.selectedTopology}`);
  console.log(`Evidence items: ${result.evidenceCount}`);
  if (critique && critique.issues.length > 0) {
    console.log(
      `Critique: ${critique.issues.length} issues (${critique.high_severity_count} high-severity)`
    );
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
  activeLlmProvider,
  activeSearchProviders,
  applyCritique,
  assessClarification,
  buildAdaptiveResearchPlan,
  buildEvaluationPack,
  buildExecutionHandoff,
  buildKnowledgeMap,
  buildResearchPlan,
  buildStrategicContext,
  classifySource,
  critiqueDecisionPhase,
  deepResearch,
  executeResearchPhase,
  getLlmJsonProvider,
  planResearchPhase,
  prepareRun,
  research,
  runResearchAgents,
  setLlmJsonProvider,
  supersedeAdr,
  synthesizeDecisionPhase,
  writeRunArtifacts
};
