#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION = "0.1.0";

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
      "citation",
      "source",
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
    flags[key] = next;
    index += 1;
  }

  return { command, inputPath, flags };
}

function usage() {
  return `Usage:
  adr research <product-context.md> --domain <domain> --decision <decision> --out <dir>

Example:
  npm run adr -- research examples/logistics-contract-mesh/product-context.md \\
    --domain "global logistics contract analysis" \\
    --decision "retrieval topology" \\
    --out /tmp/adr-output`;
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

function contentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function findEvidence(content, patterns) {
  const normalized = content.toLowerCase();
  return patterns.filter((pattern) => normalized.includes(pattern));
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
  if (/transaction|aggregate|source of truth|source-of-truth/i.test(content)) {
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

async function main() {
  const { command, inputPath, flags } = parseArgs(process.argv.slice(2));

  if (command !== "research") {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  await research({ inputPath, flags });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
