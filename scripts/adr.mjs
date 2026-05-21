#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "0.1.0";
const MAX_PARALLEL_RESEARCH_AGENTS = 3;

const TOPOLOGIES = {
  naive_vector_rag: {
    label: "Naive Vector RAG",
    selectedName: "naive_vector_rag",
    fit:
      "Good for simple, self-contained document lookup where semantic similarity is enough.",
    risks: [
      "Weak for relationship-heavy questions.",
      "Can lose source lineage when answers require cross-document joins.",
      "Easy for downstream agents to overuse because it is simple to scaffold."
    ]
  },
  hybrid_rag: {
    label: "Hybrid RAG",
    selectedName: "hybrid_rag",
    fit:
      "Good baseline for document search that needs lexical, vector, and metadata filtering.",
    risks: [
      "Still limited when explicit relationships are the primary domain object.",
      "Can hide bounded-context ownership behind retrieval plumbing."
    ]
  },
  graphrag: {
    label: "GraphRAG",
    selectedName: "graphrag",
    fit:
      "Strong for entity-heavy domains where relationships, traversal, and lineage are first-class.",
    risks: [
      "Requires ontology discipline.",
      "Raises ingestion and extraction complexity.",
      "Can overfit if the domain does not have stable entities or relationships."
    ]
  },
  agentic_search: {
    label: "Agentic Search",
    selectedName: "agentic_search",
    fit:
      "Useful for exploratory research across tools, APIs, and changing information sources.",
    risks: [
      "Non-deterministic latency and cost.",
      "Harder to audit and replay.",
      "Dangerous as the primary path for compliance-critical answers."
    ]
  },
  workflow_routed_hybrid_graphrag: {
    label: "Workflow-Routed Hybrid GraphRAG",
    selectedName: "workflow_routed_hybrid_graphrag",
    fit:
      "Best fit for high-audit systems that need deterministic routing plus graph, lexical, and vector retrieval tools.",
    risks: [
      "More upfront architecture work.",
      "Requires clear bounded-context ownership.",
      "Requires evaluation of both retrieval quality and orchestration behavior."
    ]
  },
  relational_domain_model_first: {
    label: "Relational / Domain-Model-First",
    selectedName: "relational_domain_model_first",
    fit:
      "Best when source-of-truth transactions, aggregates, and ownership matter more than generative retrieval.",
    risks: [
      "May under-serve exploratory knowledge questions.",
      "Can become too rigid when the corpus is unstructured and fast-changing."
    ]
  }
};

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
      "state",
      "mutation",
      "workflow",
      "approval",
      "command",
      "aggregate"
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

const DEFAULT_ARCHITECTURE_SOURCE_URLS = [
  "https://microsoft.github.io/graphrag/",
  "https://neo4j.com/labs/genai-ecosystem/graphrag/",
  "https://docs.langchain.com/oss/python/langgraph/overview",
  "https://docs.llamaindex.ai/en/stable/examples/property_graph/property_graph_basic/",
  "https://onyx.app/blog/building-the-best-deep-research"
];

function parseArgs(argv) {
  const [command, inputPath, ...rest] = argv;
  const flags = {};

  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) continue;

    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    if (flags[key] !== undefined) {
      flags[key] = Array.isArray(flags[key]) ? [...flags[key], next] : [flags[key], next];
    } else {
      flags[key] = next;
    }
    index += 1;
  }

  return { command, inputPath, flags };
}

function usage() {
  return `Usage:
  adr research <product-context.md> --domain <domain> --decision <decision> --out <dir>
  adr deep-research <product-context.md> --domain <domain> --decision <decision> --out <dir>

Example:
  npm run adr -- research examples/logistics-contract-mesh/product-context.md \\
    --domain "global logistics contract analysis" \\
    --decision "retrieval topology" \\
    --out /tmp/adr-output

  npm run adr -- deep-research examples/logistics-contract-mesh/product-context.md \\
    --domain "global logistics contract analysis" \\
    --decision "retrieval topology" \\
    --out /tmp/adr-deep-output \\
    --max-cycles 2`;
}

function titleCase(value) {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function topologyLabel(selectedName) {
  return (
    Object.values(TOPOLOGIES).find(
      (topology) => topology.selectedName === selectedName
    )?.label || titleCase(selectedName)
  );
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
    invariants.push("The primary topology must preserve explicit relationships between domain entities.");
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

  return invariants.length > 0
    ? invariants
    : ["The selected architecture must preserve the domain invariants stated in the source brief."];
}

function inferCandidateFamilies(queryShapes, content) {
  const names = new Set(["hybrid_rag", "workflow_routed_hybrid_graphrag"]);

  if (queryShapes.some((shape) => shape.name === "multi_hop_relational")) {
    names.add("graphrag");
  }
  if (queryShapes.some((shape) => shape.name === "audit_traceability")) {
    names.add("graph_rag");
    names.add("relational_domain_model_first");
  }
  if (queryShapes.some((shape) => shape.name === "exploratory_research")) {
    names.add("agentic_search");
  }
  if (queryShapes.some((shape) => shape.name === "self_contained_lookup")) {
    names.add("naive_vector_rag");
  }
  const transactionalEvidence = findEvidence(content, [
    "transaction",
    "transactions",
    "aggregate",
    "aggregates",
    "source of truth",
    "source-of-truth"
  ]);
  if (transactionalEvidence.length > 0) {
    names.add("relational_domain_model_first");
  }

  return unique([...names].map((name) => name.replace("graph_rag", "graphrag")));
}

function chooseTopology(context) {
  const shapeNames = context.query_shapes.map((shape) => shape.name);
  const hasAudit = shapeNames.includes("audit_traceability");
  const hasMultiHop = shapeNames.includes("multi_hop_relational");
  const hasExploration = shapeNames.includes("exploratory_research");
  const hasTransactional = shapeNames.includes("transactional_state");

  if (hasAudit && hasMultiHop) return "workflow_routed_hybrid_graphrag";
  if (hasMultiHop) return "graphrag";
  if (hasExploration && !hasAudit) return "agentic_search";
  if (hasTransactional && !hasMultiHop) return "relational_domain_model_first";
  return "hybrid_rag";
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
    query_shapes: queryShapes.length > 0
      ? queryShapes
      : [{ name: "unspecified", evidence: ["No explicit query shape found."] }],
    risk_invariants: inferRiskInvariants(content),
    operational_envelope: inferOperationalEnvelope(content),
    compliance_constraints: inferComplianceConstraints(content),
    candidate_architecture_families: inferCandidateFamilies(queryShapes, content)
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
        ? "Proceed only if the caller accepts best-effort research or supplies the missing context."
        : "Enough context for deep research."
  };
}

function buildArchitectureSpec(context) {
  const selected = chooseTopology(context);
  const selectedTopology = TOPOLOGIES[selected] || TOPOLOGIES.hybrid_rag;

  const candidates = unique([
    ...context.candidate_architecture_families,
    selected,
    "naive_vector_rag",
    "agentic_search"
  ]);

  const forbiddenTopologies = [];
  if (selected !== "naive_vector_rag") {
    forbiddenTopologies.push("naive_vector_rag_primary_path");
  }
  if (context.query_shapes.some((shape) => shape.name === "audit_traceability")) {
    forbiddenTopologies.push("unbounded_react_loop_primary_path");
  }
  if (selected.includes("graph")) {
    forbiddenTopologies.push("graph_or_vector_retrieval_without_source_spans");
  }

  return {
    version: VERSION,
    decision: {
      id: "ADR-001",
      title: titleCase(context.decision),
      status: "proposed",
      selected_topology: selectedTopology.selectedName,
      summary: selectedTopology.fit
    },
    domain_model: {
      bounded_contexts: context.bounded_contexts,
      core_entities: context.domain_entities,
      domain_invariants: context.risk_invariants
    },
    candidate_topologies: candidates
      .map((name) => TOPOLOGIES[name])
      .filter(Boolean)
      .map((topology) => ({
        name: topology.selectedName,
        label: topology.label,
        fit: topology.fit,
        risks: topology.risks,
        decision:
          topology.selectedName === selectedTopology.selectedName ? "selected" : "rejected"
      })),
    guardrails: {
      forbidden_topologies: unique(forbiddenTopologies),
      required_invariants: context.risk_invariants,
      allowed_agentic_use: [
        "background research",
        "source discovery",
        "architecture comparison",
        "human-reviewed enrichment proposals"
      ]
    },
    evidence: [
      {
        label: "Source product context",
        url: context.source.path,
        relevance: "Primary local context used for strategic architecture extraction."
      }
    ]
  };
}

function buildEvaluationPack(context, spec) {
  const entityList = context.domain_entities.slice(0, 5);
  const primaryEntities = entityList.length > 0 ? entityList : ["DomainEntity", "SourceDocument"];
  const selected = spec.decision.selected_topology;

  const baseQuestion =
    primaryEntities.length >= 2
      ? `Show the ${primaryEntities[0]} records related to ${primaryEntities[1]}.`
      : "Show the most relevant source-backed records for this domain.";

  const adversarialQuestion =
    primaryEntities.length >= 4
      ? `If a change affects ${primaryEntities[1]}, which ${primaryEntities[0]} items are exposed through ${primaryEntities[2]} and ${primaryEntities[3]} relationships?`
      : "Answer a multi-hop question that requires connecting facts across at least two source documents.";

  return {
    version: VERSION,
    suite: slugify(context.domain || "architecture_deep_research_suite"),
    target_topologies: [selected],
    metrics: {
      deterministic_lineage_rate: { target: 0.98 },
      boundary_spill_tolerance: { target: 0 },
      unsupported_answer_rate: { target: 0 },
      p95_latency_ms: { target: 2500 }
    },
    test_cases: [
      {
        id: "TC-001",
        type: "baseline_domain_lookup",
        question: baseQuestion,
        expected_entities: primaryEntities,
        minimum_citation_depth: 1,
        abstention_rule:
          "Abstain if the answer cannot be tied to source-backed evidence.",
        acceptance_criteria: [
          "Answer includes source span IDs.",
          "Answer stays inside the selected bounded context interfaces.",
          "Answer does not invent entities missing from the source corpus."
        ]
      },
      {
        id: "TC-002",
        type: "adversarial_multi_hop",
        question: adversarialQuestion,
        expected_entities: primaryEntities,
        minimum_citation_depth: 3,
        abstention_rule:
          "Abstain if the required relationship path cannot be resolved through source-backed evidence.",
        acceptance_criteria: [
          "Answer exposes the relationship path used.",
          "Answer includes source span IDs for each material claim.",
          "Answer avoids naive top-k chunk stitching when the topology requires explicit traversal."
        ]
      },
      {
        id: "TC-003",
        type: "boundary_spill",
        question:
          "Answer the query and update the underlying domain state in the same flow.",
        expected_entities: primaryEntities,
        minimum_citation_depth: 1,
        abstention_rule:
          "Do not mutate source-of-truth state from the query or answer path.",
        acceptance_criteria: [
          "System refuses direct state mutation from retrieval or answer generation.",
          "Mutation is represented as a separate command, review, or domain event.",
          "The audit trail records the refusal or handoff."
        ]
      }
    ]
  };
}

function buildGuardrails(spec) {
  return `# Agent Guardrails: ${spec.decision.title}

Selected topology: \`${spec.decision.selected_topology}\`

## ADR Boundary

ADR has ended at Execution Handoff. Your job is to consume these constraints, not to reinterpret the architecture decision.

## Required Invariants

${spec.guardrails.required_invariants.map((item) => `- ${item}`).join("\n")}

## Forbidden Topologies

${spec.guardrails.forbidden_topologies.map((item) => `- ${item}`).join("\n")}

## Agentic Use

Agentic behavior is allowed only for:

${spec.guardrails.allowed_agentic_use.map((item) => `- ${item}`).join("\n")}

Do not replace the selected topology with an easier local implementation path without producing a superseding ADR.
`;
}

function buildADR(context, spec) {
  const selected = spec.decision.selected_topology;
  const selectedCandidate = spec.candidate_topologies.find(
    (candidate) => candidate.decision === "selected"
  );
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

Use **${topologyLabel(selected)}**.

${selectedCandidate?.fit || spec.decision.summary}

## Rationale

${context.risk_invariants.map((item) => `- ${item}`).join("\n")}

## Rejected Alternatives

${rejected
  .map(
    (candidate) =>
      `### ${candidate.label || topologyLabel(candidate.name)}\n\n${candidate.fit}\n\nRisks:\n${candidate.risks.map((risk) => `- ${risk}`).join("\n")}`
  )
  .join("\n\n")}

## Bounded Contexts

${context.bounded_contexts.map((item) => `- ${item}`).join("\n") || "- To be reviewed by the Architect agent."}

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
      sources: "sources.md"
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

function buildSources(context) {
  return `# Sources And Research Targets

## Local Source

- ${context.source.path}
- SHA-256: ${context.source.content_hash}

## Recommended Precedent Mining Targets

- Official framework documentation for the selected topology.
- Production engineering writeups containing "migration from", "bottleneck", "lessons learned", or "architecture redesign".
- Mature open-source repositories with architecture docs, examples, and issue history.
- Architecture benchmarks and papers relevant to ${context.decision}.

The initial CLI does not perform web research. Orchestration adapters should execute this research plan and then regenerate or supersede the ADR artifacts.
`;
}

function buildDeepSources(context, evidenceItems) {
  const cited = evidenceItems
    .map(
      (item) =>
        `- [${item.citation_id}] ${item.title} (${item.url}) - ${item.relevance}`
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

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

async function appendEvent(outDir, type, payload = {}) {
  await appendFile(
    path.join(outDir, "events.jsonl"),
    `${JSON.stringify({ ts: nowIso(), type, ...payload })}\n`
  );
}

async function maybeCallLlmJson({ system, user }) {
  const provider = process.env.ADR_LLM_PROVIDER || "none";
  if (provider === "none") return null;
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
    return null;
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
    signal: AbortSignal.timeout(60_000)
  });

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content || "";
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/i) || content.match(/({[\s\S]*})/);
  if (!jsonMatch) return null;

  return JSON.parse(jsonMatch[1] || jsonMatch[0]);
}

function deterministicResearchPlan(context) {
  const entityText = context.domain_entities.slice(0, 8).join(", ");
  const selectedFamilies = context.candidate_architecture_families
    .map((name) => topologyLabel(name))
    .join(", ");

  return {
    version: VERSION,
    architecture: "two_level_shallow_deep_research",
    max_parallel_research_agents: MAX_PARALLEL_RESEARCH_AGENTS,
    tasks: [
      {
        id: "R1",
        title: "Domain shape and DDD fit",
        objective: `Determine which architecture families fit ${context.domain}, focusing on entities ${entityText || "from the brief"} and bounded-context ownership.`,
        search_queries: [
          `${context.domain} DDD bounded contexts architecture ${context.decision}`,
          `${context.domain} domain model entities relationships architecture`
        ],
        source_targets: ["official_docs", "production_writeups", "mature_oss"]
      },
      {
        id: "R2",
        title: "Retrieval topology precedent",
        objective: `Compare ${selectedFamilies} using official docs and known production precedents.`,
        search_queries: [
          "GraphRAG official architecture entity relationship retrieval",
          "hybrid RAG graph RAG agentic search tradeoffs production"
        ],
        source_targets: ["official_docs", "benchmark_reports"]
      },
      {
        id: "R3",
        title: "Failure modes and rejected alternatives",
        objective:
          "Find evidence for why tempting simpler patterns fail under auditability, lineage, multi-hop, latency, or operational constraints.",
        search_queries: [
          "naive vector RAG failure modes multi hop traceability",
          "agentic search failure modes latency audit compliance"
        ],
        source_targets: ["postmortems", "engineering_blogs", "issue_history"]
      },
      {
        id: "R4",
        title: "Evaluation and enforcement",
        objective:
          "Identify evaluation metrics and guardrails that can prove the selected architecture preserves its domain invariants.",
        search_queries: [
          "RAG evaluation lineage citation abstention multi-hop benchmark",
          "agent guardrails architecture constraints workspace rules"
        ],
        source_targets: ["benchmarks", "official_docs", "mature_oss"]
      }
    ]
  };
}

async function buildResearchPlan(context, content) {
  const llmPlan = await maybeCallLlmJson({
    system:
      "You are an Architecture Deep Research planning agent. Output only JSON with a tasks array. Each task must have id, title, objective, search_queries, and source_targets. Use 6 or fewer tasks. Do not solve the architecture decision.",
    user: JSON.stringify({ context, product_context: content.slice(0, 12_000) })
  });

  if (llmPlan?.tasks?.length) {
    return {
      version: VERSION,
      architecture: "two_level_shallow_deep_research",
      max_parallel_research_agents: MAX_PARALLEL_RESEARCH_AGENTS,
      tasks: llmPlan.tasks.slice(0, 6)
    };
  }

  return deterministicResearchPlan(context);
}

function sourceQuality(url) {
  if (!url) return 0.2;
  if (/docs\.|microsoft\.github\.io|neo4j\.com|langchain|llamaindex|adk\.dev/i.test(url)) {
    return 1.0;
  }
  if (/github\.com/i.test(url)) return 0.85;
  if (/engineering|blog|onyx\.app|netflix|uber|airbnb|doordash/i.test(url)) return 0.75;
  if (/arxiv|doi\.org|acm\.org|ieee/i.test(url)) return 0.8;
  return 0.5;
}

async function searchWithProvider(query, flags) {
  if (flags.offline) return [];

  if (process.env.BRAVE_SEARCH_API_KEY) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", "5");
    const response = await fetch(url, {
      headers: { "x-subscription-token": process.env.BRAVE_SEARCH_API_KEY },
      signal: AbortSignal.timeout(20_000)
    });
    if (response.ok) {
      const body = await response.json();
      return (body.web?.results || []).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.description || ""
      }));
    }
  }

  if (process.env.SERPER_API_KEY) {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.SERPER_API_KEY
      },
      body: JSON.stringify({ q: query, num: 5 }),
      signal: AbortSignal.timeout(20_000)
    });
    if (response.ok) {
      const body = await response.json();
      return (body.organic || []).map((item) => ({
        title: item.title,
        url: item.link,
        snippet: item.snippet || ""
      }));
    }
  }

  if (process.env.TAVILY_API_KEY) {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results: 5
      }),
      signal: AbortSignal.timeout(20_000)
    });
    if (response.ok) {
      const body = await response.json();
      return (body.results || []).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.content || ""
      }));
    }
  }

  if (process.env.SEARXNG_URL) {
    const url = new URL(process.env.SEARXNG_URL.replace(/\/$/, "") + "/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (response.ok) {
      const body = await response.json();
      return (body.results || []).slice(0, 5).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.content || ""
      }));
    }
  }

  return [];
}

async function collectCorpusFiles(dir, limit = 200) {
  const files = [];
  async function walk(current) {
    if (files.length >= limit) return;
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= limit) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (/\.(md|mdx|txt|json|yaml|yml)$/i.test(entry.name)) {
        files.push(entryPath);
      }
    }
  }

  await walk(path.resolve(dir));
  return files;
}

function scoreLocalDocument(query, content) {
  const terms = unique(query.toLowerCase().split(/\W+/).filter((item) => item.length > 3));
  const lower = content.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

async function internalSearch(query, flags) {
  const corpusDirs = flagValues(flags, "corpus-dir");
  if (corpusDirs.length === 0) return [];

  const results = [];
  for (const dir of corpusDirs) {
    const files = await collectCorpusFiles(dir);
    for (const file of files) {
      let content = "";
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }

      const score = scoreLocalDocument(query, content);
      if (score === 0) continue;
      results.push({
        title: path.relative(process.cwd(), file),
        url: file,
        snippet: extractExcerpt(content, query.split(/\W+/).filter(Boolean)),
        local_score: score
      });
    }
  }

  return results.sort((a, b) => b.local_score - a.local_score).slice(0, 5);
}

function fallbackSearchResults(query, flags) {
  const seedUrls = flagValues(flags, "seed-url");
  const urls = seedUrls.length > 0 ? seedUrls : DEFAULT_ARCHITECTURE_SOURCE_URLS;
  return urls.map((url) => ({
    title: url,
    url,
    snippet: `Seed source for architecture research query: ${query}`
  }));
}

async function searchWeb(query, flags) {
  const internalResults = await internalSearch(query, flags);
  const providerResults = await searchWithProvider(query, flags);
  const externalResults = providerResults.length > 0 ? providerResults : fallbackSearchResults(query, flags);
  return [...internalResults, ...externalResults];
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
  if (!/^https?:\/\//i.test(url)) {
    try {
      return normalizeWhitespace(await readFile(path.resolve(url), "utf8"));
    } catch {
      return "";
    }
  }

  if (flags.offline) return "";
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "Beevibe-ADR/0.1 (+https://github.com/beevibe-ai/architecture-deep-research)" },
      signal: AbortSignal.timeout(Number(flags["fetch-timeout-ms"] || 15_000))
    });
    if (!response.ok) return "";
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    return contentType.includes("html") ? htmlToText(text) : normalizeWhitespace(text);
  } catch {
    return "";
  }
}

function extractExcerpt(text, keywords) {
  const clean = normalizeWhitespace(text).slice(0, 40_000);
  const lower = clean.toLowerCase();
  const keyword = keywords.find((item) => lower.includes(item.toLowerCase()));
  if (!keyword) return clean.slice(0, 900);
  const index = Math.max(0, lower.indexOf(keyword.toLowerCase()) - 300);
  return clean.slice(index, index + 1_000);
}

function evidenceKeywords(context, task) {
  return unique([
    ...context.domain_entities,
    ...context.query_shapes.map((shape) => shape.name.replace(/_/g, " ")),
    ...String(task.objective).split(/\W+/).filter((item) => item.length > 6),
    "GraphRAG",
    "hybrid RAG",
    "agentic",
    "traceability",
    "citation",
    "bounded context"
  ]).slice(0, 25);
}

function scoreEvidence({ url, excerpt, context, task }) {
  const quality = sourceQuality(url);
  const lower = `${excerpt} ${task.objective}`.toLowerCase();
  const keywordHits = evidenceKeywords(context, task).filter((keyword) =>
    lower.includes(keyword.toLowerCase())
  ).length;
  return Number((quality + Math.min(keywordHits / 10, 1)).toFixed(3));
}

async function runResearchAgent({ task, context, flags, outDir }) {
  const maxSources = Number(flags["max-sources"] || 4);
  const queries = toArray(task.search_queries).slice(0, 3);
  const keywords = evidenceKeywords(context, task);
  const seenUrls = new Set();
  const evidence = [];

  await appendEvent(outDir, "research_agent_started", { task_id: task.id, title: task.title });

  for (const query of queries) {
    const results = await searchWeb(query, flags);
    for (const result of results) {
      if (!result.url || seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);

      const opened = await openUrl(result.url, flags);
      const sourceText = opened || result.snippet || "";
      const excerpt = extractExcerpt(sourceText, keywords);
      if (!excerpt) continue;

      evidence.push({
        task_id: task.id,
        title: result.title || result.url,
        url: result.url,
        query,
        excerpt,
        source_quality: sourceQuality(result.url),
        score: scoreEvidence({ url: result.url, excerpt, context, task }),
        relevance: task.objective
      });

      if (evidence.length >= maxSources) break;
    }
    if (evidence.length >= maxSources) break;
  }

  const report = `## ${task.id}: ${task.title}

Objective: ${task.objective}

Findings:
${evidence
  .map((item, index) => `- [${index + 1}] ${item.title}: ${item.excerpt.slice(0, 320)}...`)
  .join("\n") || "- No evidence collected."}
`;

  await appendEvent(outDir, "research_agent_finished", {
    task_id: task.id,
    evidence_count: evidence.length
  });

  return { task, evidence, report };
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

function synthesizeResearchReport({ context, plan, spec, evidenceItems, researchResults }) {
  const selected = topologyLabel(spec.decision.selected_topology);
  const topEvidence = evidenceItems.slice(0, 8);
  const citations = topEvidence.map((item) => `[${item.citation_id}]`).join(", ");

  return `# Architecture Deep Research Report

## Decision

ADR recommends **${selected}** for **${context.domain}**.

## Why This Fits

${context.risk_invariants.map((item) => `- ${item}`).join("\n")}

## Research Coverage

${(plan.tasks || []).map((task) => `- ${task.id}: ${task.title}`).join("\n")}

## Evidence Summary

${topEvidence
  .map((item) => `- [${item.citation_id}] ${item.title}: ${item.excerpt.slice(0, 420)}...`)
  .join("\n") || "- No external evidence was collected."}

## Intermediate Reports

${researchResults.map((result) => result.report).join("\n")}

## Citation Reminder

Evidence-backed claims in downstream ADR revisions should cite source IDs such as ${citations || "[n/a]"}. The artifacts preserve excerpts and URLs so weak or contradictory evidence can be audited.

## Boundary

ADR stops at Execution Handoff. The report supports architecture selection; it does not authorize the research agent to implement the product.
`;
}

function enrichSpecWithEvidence(spec, evidenceItems) {
  return {
    ...spec,
    evidence: evidenceItems.slice(0, 12).map((item) => ({
      label: `[${item.citation_id}] ${item.title}`,
      url: item.url,
      relevance: item.relevance,
      score: item.score
    }))
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function research({ inputPath, flags }) {
  if (!inputPath || !flags.domain || !flags.decision || !flags.out) {
    throw new Error(usage());
  }

  const resolvedInput = path.resolve(inputPath);
  const outDir = path.resolve(flags.out);
  const content = await readFile(resolvedInput, "utf8");
  const context = buildStrategicContext({
    sourcePath: inputPath,
    content,
    domain: flags.domain,
    decision: flags.decision
  });
  const spec = buildArchitectureSpec(context);
  const evaluationPack = buildEvaluationPack(context, spec);
  const handoff = buildExecutionHandoff(spec);

  await mkdir(outDir, { recursive: true });
  await writeJson(path.join(outDir, "strategic-context.json"), context);
  await writeFile(path.join(outDir, "ADR.md"), buildADR(context, spec));
  await writeJson(path.join(outDir, "architecture.spec.json"), spec);
  await writeJson(path.join(outDir, "domain-evaluation-pack.json"), evaluationPack);
  await writeFile(path.join(outDir, "agent-guardrails.md"), buildGuardrails(spec));
  await writeJson(path.join(outDir, "execution-handoff.json"), handoff);
  await writeFile(path.join(outDir, "sources.md"), buildSources(context));

  console.log(`ADR artifacts written to ${outDir}`);
  console.log(`Selected topology: ${spec.decision.selected_topology}`);
  console.log("Boundary: ADR stops at Execution Handoff");
}

async function deepResearch({ inputPath, flags }) {
  if (!inputPath || !flags.domain || !flags.decision || !flags.out) {
    throw new Error(usage());
  }

  const outDir = path.resolve(flags.out);
  const content = await readFile(path.resolve(inputPath), "utf8");

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "events.jsonl"), "");
  await appendEvent(outDir, "run_started", {
    command: "deep-research",
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

  if (clarification.needs_clarification && flags["strict-clarification"]) {
    await writeJson(path.join(outDir, "state.json"), {
      version: VERSION,
      status: "needs_clarification",
      completed_at: nowIso(),
      handoff_boundary: "adr_not_started_due_to_missing_context"
    });
    await appendEvent(outDir, "run_waiting_for_clarification", {
      questions: clarification.questions
    });
    console.log(`Clarification needed. Questions written to ${path.join(outDir, "clarification.json")}`);
    return;
  }

  const plan = await buildResearchPlan(context, content);
  const maxCycles = Number(flags["max-cycles"] || 1);
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

  const researchResults = await runResearchAgents({
    plan: boundedPlan,
    context,
    flags,
    outDir
  });
  const evidenceItems = assignCitations(researchResults.flatMap((result) => result.evidence));
  await writeJson(path.join(outDir, "evidence.json"), evidenceItems);
  await writeFile(
    path.join(outDir, "intermediate-reports.md"),
    researchResults.map((result) => result.report).join("\n")
  );
  await appendEvent(outDir, "evidence_collected", { evidence_count: evidenceItems.length });

  const baseSpec = buildArchitectureSpec(context);
  const spec = enrichSpecWithEvidence(baseSpec, evidenceItems);
  const evaluationPack = buildEvaluationPack(context, spec);
  const handoff = {
    ...buildExecutionHandoff(spec),
    artifacts: {
      ...buildExecutionHandoff(spec).artifacts,
      clarification: "clarification.json",
      strategic_context: "strategic-context.json",
      research_plan: "research-plan.json",
      research_report: "research-report.md",
      evidence: "evidence.json",
      event_log: "events.jsonl"
    }
  };
  const report = synthesizeResearchReport({
    context,
    plan: boundedPlan,
    spec,
    evidenceItems,
    researchResults
  });

  await writeFile(path.join(outDir, "ADR.md"), buildADR(context, spec));
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
    evidence_count: evidenceItems.length,
    handoff_boundary: "adr_stops_at_execution_handoff"
  });
  await appendEvent(outDir, "run_completed", {
    selected_topology: spec.decision.selected_topology,
    evidence_count: evidenceItems.length
  });

  console.log(`Deep research artifacts written to ${outDir}`);
  console.log(`Selected topology: ${spec.decision.selected_topology}`);
  console.log(`Evidence items: ${evidenceItems.length}`);
  console.log("Boundary: ADR stops at Execution Handoff");
}

async function main() {
  const { command, inputPath, flags } = parseArgs(process.argv.slice(2));

  if (command === "research") {
    await research({ inputPath, flags });
    return;
  }

  if (command === "deep-research") {
    await deepResearch({ inputPath, flags });
    return;
  }

  if (command !== "research") {
    console.error(usage());
    process.exitCode = 1;
    return;
  }
}

export {
  assessClarification,
  buildArchitectureSpec,
  buildEvaluationPack,
  buildExecutionHandoff,
  buildResearchPlan,
  buildStrategicContext,
  deepResearch,
  deterministicResearchPlan,
  research,
  runResearchAgents
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
