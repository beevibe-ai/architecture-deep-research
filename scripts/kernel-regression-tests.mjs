#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { mkdir, writeFile } from "node:fs/promises";

import {
  applyCitationAudit,
  assessClarification,
  buildGuardrails,
  buildKnowledgeMap,
  buildStrategicContext,
  classifySource,
  deriveComparisonAxes,
  discoverPatterns,
  extractClaims,
  inferDecisionKind,
  injectDiscoveredEvidence,
  prepareRun,
  setLlmJsonProvider,
  synthesizeDecisionPhase,
  writeJson,
  writeRunArtifacts
} from "../src/kernel.mjs";

function installProvider(handler) {
  setLlmJsonProvider(async ({ label }) => handler(label), { label: "regression-fixture" });
}

// Strategic context is now LLM-derived (no more regex extractors). Install a
// fixture provider that returns a hand-crafted shape so the test stays hermetic.
installProvider((label) => {
  if (label !== "strategic_context_extractor") {
    throw new Error(`fixture: unexpected llm label before context extraction: ${label}`);
  }
  return {
    domain_entities: ["Contract", "Vendor", "Shipment", "Jurisdiction"],
    bounded_contexts: [
      "IngestionContext",
      "KnowledgeGraphContext",
      "QueryOrchestrationContext"
    ],
    query_shapes: [
      { name: "multi_hop_relational", evidence: ["multi-hop entity relationships"] },
      { name: "audit_traceability", evidence: ["audit lineage"] }
    ],
    risk_invariants: [
      "Answers must resolve to source-backed evidence before being returned.",
      "Compliance-critical flows must be deterministic, reviewable, and replayable."
    ],
    operational_envelope: {
      latency: "not_specified",
      cost: "not_specified",
      scale: "not_specified",
      availability: "not_specified"
    },
    compliance_constraints: ["audit traceability"]
  };
});

const context = await buildStrategicContext({
  sourcePath: "regression-fixture.md",
  content:
    "Build a source-backed retrieval system with audit lineage, multi-hop entity relationships, bounded contexts, and deterministic reviewable workflows.",
  domain: "global logistics contract analysis",
  decision: "retrieval topology"
});

function evidenceItem(overrides = {}) {
  return {
    citation_id: 1,
    task_id: "T1",
    title: "GraphRAG paper",
    url: "https://arxiv.org/abs/2404.16130",
    provider: "fixture",
    query: "graphrag architecture benchmark",
    excerpt:
      "GraphRAG uses graph-structured retrieval to preserve explicit relationships and improve multi-hop question answering with source-backed evidence.",
    source_type: "paper_or_benchmark",
    source_quality: 0.85,
    relevance: "Acquire architecture evidence.",
    retrieved_at: "2026-05-22T00:00:00.000Z",
    fetch_status: "fixture_replay",
    content_hash: "abc123",
    raw_text_path: "source-snapshots/abc123.txt",
    raw_text_bytes: 120,
    keyword_hits: ["graph", "retrieval"],
    score: 0.8,
    claims: [
      {
        claim: "GraphRAG supports multi-hop relationship retrieval.",
        architecture_family: "GraphRAG",
        polarity: "positive",
        confidence: "0.9"
      }
    ],
    ...overrides
  };
}

try {
  const knowledgeMap = buildKnowledgeMap([
    evidenceItem(),
    evidenceItem({
      citation_id: 2,
      url: "https://github.com/microsoft/graphrag",
      source_type: "mature_oss",
      score: 0.7,
      claims: [
        {
          claim: "GraphRAG has mature OSS implementation evidence.",
          architecture_family: "GraphRAG",
          polarity: "support",
          confidence: undefined
        }
      ]
    })
  ]);

  assert.equal(knowledgeMap.promoted_candidates.length, 1);
  assert.equal(knowledgeMap.promoted_candidates[0].name, "graphrag");
  assert.equal(knowledgeMap.promoted_candidates[0].support.length, 2);
  assert.equal(Number.isFinite(knowledgeMap.promoted_candidates[0].score), true);

  installProvider((label) => {
    assert.equal(label, "architecture_synthesis_agent");
    // The synthesizer tries to invent "invented_topology" which is NOT in
    // promoted_candidates; the parser must drop it from ranked_options and
    // fall back to mode = "deferred".
    return {
      decision: {
        id: "ADR-X",
        title: "Retrieval Topology",
        status: "selected",
        mode: "recommended",
        ranked_options: [
          {
            name: "invented_topology",
            label: "Invented",
            summary: "Looks plausible but is not promoted.",
            when_to_pick: [],
            when_not_to_pick: [],
            strong_axes: [],
            weak_axes: [],
            risks: ["No promoted evidence."],
            evidence_citations: [999],
            confidence: 0.9
          }
        ],
        recommendation: { name: "invented_topology", why: "Looks good." },
        summary: "Invented topology should not clear the gate.",
        evidence_citations: [999]
      },
      domain_model: {},
      evidence_summary: {}
    };
  });

  const gatedSpec = await synthesizeDecisionPhase({
    context,
    knowledgeMap: buildKnowledgeMap([]),
    evidenceItems: [],
    comparisonMatrix: null
  });

  // No promoted candidates → invented option gets filtered → ranked_options
  // is empty → mode = "deferred" → selected_topology = HUMAN_REVIEW back-compat.
  assert.equal(gatedSpec.decision.mode, "deferred");
  assert.deepEqual(gatedSpec.decision.ranked_options, []);
  assert.equal(gatedSpec.decision.recommendation, null);
  assert.equal(gatedSpec.decision.selected_topology, "requires_human_architecture_review");
  assert.equal(gatedSpec.decision.status, "proposed");
  assert.deepEqual(gatedSpec.candidate_topologies, []);

  // applyCitationAudit drops the recommendation (not selected_topology now).
  // Build a recommended-mode spec by hand and verify the audit demotes it
  // to ranked_options + null recommendation, preserving ranked_options.
  const recommendedSpec = {
    ...gatedSpec,
    decision: {
      ...gatedSpec.decision,
      mode: "recommended",
      ranked_options: [
        {
          name: "graphrag",
          label: "GraphRAG",
          summary: "ok",
          required_invariants: ["maintain lineage"],
          forbidden_topologies: ["pure_vector_retrieval"],
          evidence_citations: [1],
          confidence: 0.9
        },
        {
          name: "vector_rag",
          label: "Vector RAG",
          required_invariants: [],
          forbidden_topologies: [],
          evidence_citations: [],
          confidence: 0.6
        }
      ],
      recommendation: { name: "graphrag", why: "best on axes" },
      selected_topology: "graphrag"
    },
    guardrails: {
      ...gatedSpec.guardrails,
      required_invariants: ["maintain lineage"],
      forbidden_topologies: ["pure_vector_retrieval"]
    }
  };

  const citationDowngrade = applyCitationAudit({
    spec: recommendedSpec,
    citationAudit: {
      items: [
        {
          citation_id: 1,
          claim_context: "selected_topology_summary",
          verified: false,
          confidence: 0.1,
          reason: "unsupported"
        }
      ]
    },
    flags: {}
  });
  assert.equal(citationDowngrade.downgraded, true);
  assert.equal(citationDowngrade.spec.decision.mode, "ranked_options");
  assert.equal(citationDowngrade.spec.decision.recommendation, null);
  assert.equal(citationDowngrade.spec.decision.selected_topology, "ranked_options");
  // ranked_options must survive the downgrade — that is the whole point.
  assert.equal(citationDowngrade.spec.decision.ranked_options.length, 2);
  // Back-compat roll-up invariants/forbidden go empty when no recommendation.
  assert.deepEqual(citationDowngrade.spec.guardrails.required_invariants, []);
  assert.deepEqual(citationDowngrade.spec.guardrails.forbidden_topologies, []);

  installProvider((label) => {
    if (label === "evaluation_pack_agent") {
      return {
        suite: "regression_suite",
        target_topologies: ["graphrag"],
        metrics: {
          deterministic_lineage_rate: { target: "not numeric" },
          boundary_spill_tolerance: { target: -1 },
          unsupported_answer_rate: { target: 5 }
        },
        test_cases: [
          {
            id: "TC-001",
            type: "adversarial_multi_hop",
            question: "Can the topology preserve cited multi-hop lineage?",
            expected_entities: ["Contract", "Vendor"],
            minimum_citation_depth: 2,
            acceptance_criteria: ["Must cite source evidence."]
          }
        ]
      };
    }
    if (label === "uncited_claim_scanner") {
      return {
        claims: [
          {
            artifact: "ADR.md",
            claim_text: "GraphRAG supports multi-hop relationship retrieval.",
            citation_ids: [1],
            needs_citation: false,
            severity: "low",
            reason: "Already supported by evidence [1]."
          },
          {
            artifact: "ADR.md",
            claim_text: "GraphRAG outperforms competitors on every benchmark.",
            citation_ids: [],
            needs_citation: true,
            severity: "high",
            reason: "Sweeping superiority claim with no cited evidence."
          },
          "garbage_string_entry_to_test_normalizer_filter"
        ],
        summary: "Found one uncited high-severity claim and one supported claim."
      };
    }
    throw new Error(`unexpected label ${label}`);
  });

  const outDir = await mkdtemp(path.join(os.tmpdir(), "adr-kernel-regression-"));
  await writeRunArtifacts({
    context,
    plan: {
      version: "0.2.0",
      architecture: "fixture",
      max_parallel_research_agents: 1,
      tasks: [
        {
          id: "T1",
          title: "Fixture task",
          objective: "Acquire evidence.",
          search_queries: ["graphrag"],
          source_targets: []
        }
      ]
    },
    spec: {
      version: "0.2.0",
      decision: {
        id: "ADR-001",
        title: "Retrieval Topology",
        status: "proposed",
        selected_topology: "graphrag",
        summary: "GraphRAG is selected from promoted evidence.",
        evidence_citations: [1]
      },
      domain_model: {
        bounded_contexts: ["KnowledgeGraphContext"],
        core_entities: ["Contract", "Vendor"],
        domain_invariants: ["Answers must resolve to source-backed evidence before being returned."]
      },
      candidate_topologies: [
        {
          name: "graphrag",
          fit: "Preserves explicit relationships.",
          risks: ["Operational complexity."],
          decision: "selected",
          evidence_citations: [1],
          confidence: 0.8
        }
      ],
      guardrails: {
        forbidden_topologies: [],
        required_invariants: [
          "Answers must resolve to source-backed evidence before being returned."
        ],
        allowed_agentic_use: ["source discovery"],
        enforcement_notes: []
      },
      evidence_summary: {}
    },
    evidenceItems: [evidenceItem()],
    researchResults: [{ report: "Fixture report." }],
    knowledgeMap,
    outDir,
    critique: null,
    citationAudit: null,
    comparisonMatrix: null,
    flags: {}
  });

  // Verify the claim audit ran end-to-end (it was previously skipped, leaving
  // scanUncitedClaimsPhase + its LLM-output normalization with zero coverage).
  const claimAudit = JSON.parse(
    await readFile(path.join(outDir, "claim-audit.json"), "utf8")
  );
  assert.equal(claimAudit.total_claims_checked, 2, "garbage string entry should be filtered out");
  assert.equal(claimAudit.uncited_material_claim_count, 1);
  assert.equal(claimAudit.high_severity_count, 1);
  assert.equal(claimAudit.claims[1].needs_citation, true);
  assert.equal(claimAudit.claims[1].severity, "high");

  await rm(outDir, { recursive: true, force: true });
} finally {
  setLlmJsonProvider(null);
}

// ---------------------------------------------------------------------------
// Discover-stage regression: build a tiny fake repo, install a fixture
// provider for the three discover labels, run discoverPatterns, and verify
// that all three artifacts land on disk and pass schema validation (via
// writeJson, which validates implicitly).
// ---------------------------------------------------------------------------

try {
  const discoverOutDir = await mkdtemp(path.join(os.tmpdir(), "adr-discover-test-"));
  const fakeRepoDir = await mkdtemp(path.join(os.tmpdir(), "adr-discover-repo-"));

  await writeFile(
    path.join(fakeRepoDir, "README.md"),
    [
      "# fake-repo",
      "",
      "A tiny synthetic repo used by the discover regression test.",
      "",
      "## Hard rules",
      "- No offline mode.",
      "- No mock data."
    ].join("\n")
  );
  await writeFile(
    path.join(fakeRepoDir, "package.json"),
    JSON.stringify(
      { name: "fake-repo", type: "module", scripts: {}, dependencies: {} },
      null,
      2
    )
  );
  await mkdir(path.join(fakeRepoDir, "src"), { recursive: true });
  await writeFile(
    path.join(fakeRepoDir, "src", "index.mjs"),
    "// TODO: real implementation\nexport const placeholder = true;\n"
  );

  installProvider((label) => {
    if (label === "discover_principle_extractor") {
      return {
        patterns: [
          {
            name: "esm_only_node_module",
            description: "Package declares ESM-only via type=module.",
            evidence_cite: ["package.json"],
            category: "language"
          }
        ],
        antipatterns: [
          {
            name: "no_offline_mode",
            reason: "README explicitly forbids offline mode.",
            evidence_cite: ["README.md"],
            category: "research-policy"
          }
        ]
      };
    }
    if (label === "discover_constraint_extractor") {
      return {
        stack: [
          {
            name: "node",
            category: "language",
            evidence_cite: ["package.json"]
          }
        ],
        deploy_target: { platform: "unknown", evidence_cite: ["package.json"] },
        compliance_signals: [],
        team_size_hint: "unknown",
        codebase_age_hint: "unknown"
      };
    }
    if (label === "discover_prd_drafter") {
      return {
        markdown: [
          "# Product Context: fake-repo retrieval topology",
          "",
          "A synthetic test brief.",
          "",
          "## Decision",
          "",
          "Select the retrieval topology.",
          "",
          "## Discovered context",
          "",
          "- Pattern: esm_only_node_module (package.json)",
          "- Anti-pattern: no_offline_mode (README.md)",
          "",
          "## Open questions",
          "",
          "- Latency target?",
          "- Compliance envelope?"
        ].join("\n")
      };
    }
    throw new Error(`discover regression fixture: unexpected label ${label}`);
  });

  const result = await discoverPatterns({
    flags: {
      repo: fakeRepoDir,
      decision: "retrieval topology",
      out: discoverOutDir
    }
  });

  assert.equal(result.handoffBoundary, "discover_stops_at_pdr_draft");
  assert.equal(result.principles.patterns.length, 1);
  assert.equal(result.principles.antipatterns.length, 1);
  assert.equal(result.constraints.stack.length, 1);

  const principles = JSON.parse(
    await readFile(path.join(discoverOutDir, "discovered-principles.json"), "utf8")
  );
  assert.equal(principles.patterns[0].name, "esm_only_node_module");
  assert.equal(principles.antipatterns[0].name, "no_offline_mode");
  assert.ok(principles.patterns[0].evidence_cite.includes("package.json"));

  const constraints = JSON.parse(
    await readFile(path.join(discoverOutDir, "discovered-constraints.json"), "utf8")
  );
  assert.equal(constraints.stack[0].name, "node");
  assert.equal(constraints.deploy_target.platform, "unknown");

  const draft = await readFile(path.join(discoverOutDir, "pdr.draft.md"), "utf8");
  assert.ok(draft.includes("# Product Context: fake-repo retrieval topology"));
  assert.ok(draft.includes("## Open questions"));

  const events = (await readFile(path.join(discoverOutDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const eventTypes = events.map((event) => event.type);
  assert.deepEqual(eventTypes, [
    "discover_started",
    "repo_scanned",
    "principles_extracted",
    "constraints_extracted",
    "pdr_drafted",
    "discover_completed"
  ]);

  await rm(discoverOutDir, { recursive: true, force: true });
  await rm(fakeRepoDir, { recursive: true, force: true });
} finally {
  setLlmJsonProvider(null);
}

// ---------------------------------------------------------------------------
// Follow-up coverage: synthetic-evidence injection + anti-pattern axes.
// We stage a discovered-principles.json on disk, then exercise the two
// integration points without spinning up a full deep-research run.
// ---------------------------------------------------------------------------

{
  const stagedOutDir = await mkdtemp(path.join(os.tmpdir(), "adr-followup-test-"));
  try {
    const principles = {
      version: "0.2.0",
      source: {
        repo_path: "/fake",
        scanned_at: "2026-05-23T00:00:00.000Z",
        decision: "retrieval topology"
      },
      patterns: [
        {
          name: "postgres_centric_storage",
          description: "Team uses Postgres for all persistent state.",
          evidence_cite: ["docker-compose.yml:services.postgres", "package.json:dependencies.pg"],
          architecture_family: "postgres_centric_storage"
        },
        {
          // Patterns without architecture_family should NOT produce evidence.
          name: "monorepo_layout",
          description: "Project organized as a monorepo with packages/.",
          evidence_cite: ["package.json:workspaces"]
        }
      ],
      antipatterns: [
        {
          name: "no_kafka",
          reason: "Team explicitly rejected adding Kafka — ops overhead.",
          evidence_cite: ["docs/adr/0003.md:rejected_alternatives"],
          architecture_family: "kafka_event_bus"
        },
        {
          // Anti-pattern without architecture_family contributes to AXES only,
          // not to the evidence pool.
          name: "no_implicit_globals",
          reason: "Codebase forbids implicit module globals.",
          evidence_cite: ["CONTRIBUTING.md:style"]
        }
      ]
    };
    await writeJson(path.join(stagedOutDir, "discovered-principles.json"), principles);

    // 1) Synthetic evidence injection. Only the architecture_family-tagged
    //    items should produce synthetic items in the evidence pool.
    const injection = await injectDiscoveredEvidence({
      outDir: stagedOutDir,
      evidenceItems: []
    });
    assert.equal(injection.injected, true);
    assert.equal(injection.syntheticEvidenceItems.length, 2);
    assert.deepEqual(
      injection.syntheticEvidenceItems.map((item) => item.source_type),
      ["private_corpus", "private_corpus"]
    );
    assert.equal(injection.syntheticEvidenceItems[0].claims[0].polarity, "supports");
    assert.equal(injection.syntheticEvidenceItems[0].claims[0].architecture_family, "postgres_centric_storage");
    assert.equal(injection.syntheticEvidenceItems[1].claims[0].polarity, "rejects");
    assert.equal(injection.syntheticEvidenceItems[1].claims[0].architecture_family, "kafka_event_bus");
    // Merged pool has stable citation_ids — both synthetic items got 1 and 2.
    assert.deepEqual(
      injection.evidenceItems.map((item) => item.citation_id),
      [1, 2]
    );
    // The two architecture_family-less items become axis-only signals.
    assert.equal(injection.discoveredAntipatterns.length, 2);

    // 2) Synthetic items flow into the knowledge map and pass the promotion
    //    gate because private_corpus is in the qualityGate source-type set.
    //    The pattern + supporting evidence_count >= 2 isn't quite hit by a
    //    single synthetic item, but the negative kafka claim still appears
    //    as an insufficient-evidence candidate. We just check the names land.
    const knowledgeMap = buildKnowledgeMap(injection.evidenceItems);
    const allNames = [
      ...knowledgeMap.promoted_candidates.map((c) => c.name),
      ...knowledgeMap.insufficient_evidence_candidates.map((c) => c.name)
    ];
    assert.ok(
      allNames.includes("postgres-centric-storage") || allNames.includes("postgres_centric_storage"),
      `expected postgres family in knowledge map, got: ${allNames.join(", ")}`
    );
    assert.ok(
      allNames.includes("kafka-event-bus") || allNames.includes("kafka_event_bus"),
      `expected kafka family in knowledge map, got: ${allNames.join(", ")}`
    );

    // 3) Anti-pattern axes. deriveComparisonAxes should add one axis per
    //    anti-pattern (regardless of architecture_family).
    const richContext = {
      domain: "test",
      decision: "test",
      query_shapes: [],
      operational_envelope: {
        latency: "not_specified",
        cost: "not_specified",
        scale: "not_specified",
        availability: "not_specified"
      },
      compliance_constraints: []
    };
    const axes = deriveComparisonAxes(richContext, {
      discoveredAntipatterns: injection.discoveredAntipatterns
    });
    const axisIds = axes.map((a) => a.id);
    assert.ok(
      axisIds.includes("team_antipattern_no_kafka"),
      `missing kafka anti-pattern axis: ${axisIds.join(", ")}`
    );
    assert.ok(
      axisIds.includes("team_antipattern_no_implicit_globals"),
      `missing globals anti-pattern axis: ${axisIds.join(", ")}`
    );
    const kafkaAxis = axes.find((a) => a.id === "team_antipattern_no_kafka");
    assert.ok(kafkaAxis.rationale.includes("docs/adr/0003.md"));
    assert.ok(kafkaAxis.label.startsWith("Avoids:"));
  } finally {
    await rm(stagedOutDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Discover chained-mode: when called with { chained: true }, discoverPatterns
// must preserve a pre-existing events.jsonl (it appends, does not truncate).
// This is what makes `adr deep-research --discover-first` work: the wrapper
// initializes the shared event log once, then both discover and prepareRun
// append to it.
// ---------------------------------------------------------------------------

try {
  const chainedOutDir = await mkdtemp(path.join(os.tmpdir(), "adr-chained-test-"));
  const fakeRepoDir = await mkdtemp(path.join(os.tmpdir(), "adr-chained-repo-"));
  await writeFile(
    path.join(fakeRepoDir, "README.md"),
    "# fake-chain\n\nA repo for the chained discover test.\n"
  );
  await writeFile(
    path.join(fakeRepoDir, "package.json"),
    JSON.stringify({ name: "fake-chain", type: "module" }, null, 2)
  );

  // Caller writes an upstream event first (simulating what deepResearch does
  // before invoking discoverPatterns with chained: true).
  await mkdir(chainedOutDir, { recursive: true });
  await writeFile(
    path.join(chainedOutDir, "events.jsonl"),
    JSON.stringify({ ts: "2026-05-23T00:00:00.000Z", type: "upstream_event" }) + "\n"
  );

  installProvider((label) => {
    if (label === "discover_principle_extractor") {
      return { patterns: [], antipatterns: [] };
    }
    if (label === "discover_constraint_extractor") {
      return {
        stack: [],
        deploy_target: { platform: "unknown", evidence_cite: ["package.json"] },
        compliance_signals: [],
        team_size_hint: "unknown",
        codebase_age_hint: "unknown"
      };
    }
    if (label === "discover_prd_drafter") {
      return { markdown: "# Product Context: fake-chain\n\n## Decision\n\nN/A\n" };
    }
    throw new Error(`chained discover fixture: unexpected label ${label}`);
  });

  await discoverPatterns({
    flags: {
      repo: fakeRepoDir,
      decision: "test decision",
      out: chainedOutDir
    },
    chained: true
  });

  const events = (await readFile(path.join(chainedOutDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  // The upstream event must survive (chained mode does not truncate).
  assert.equal(events[0].type, "upstream_event");
  // The six discover events follow.
  const discoverTypes = events.slice(1).map((e) => e.type);
  assert.deepEqual(discoverTypes, [
    "discover_started",
    "repo_scanned",
    "principles_extracted",
    "constraints_extracted",
    "pdr_drafted",
    "discover_completed"
  ]);

  await rm(chainedOutDir, { recursive: true, force: true });
  await rm(fakeRepoDir, { recursive: true, force: true });
} finally {
  setLlmJsonProvider(null);
}

// ---------------------------------------------------------------------------
// Sanity-check the no-injection short-circuit: when discovered-principles.json
// is absent, injectDiscoveredEvidence is a no-op.
// ---------------------------------------------------------------------------

{
  const cleanDir = await mkdtemp(path.join(os.tmpdir(), "adr-noinject-test-"));
  try {
    const result = await injectDiscoveredEvidence({
      outDir: cleanDir,
      evidenceItems: []
    });
    assert.equal(result.injected, false);
    assert.equal(result.syntheticEvidenceItems.length, 0);
    assert.equal(result.discoveredAntipatterns.length, 0);
  } finally {
    await rm(cleanDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// decision_kind: auto-detection from decision name, override via param,
// vendor-grade axes appear only in concrete mode.
// ---------------------------------------------------------------------------

{
  // Auto-detection.
  assert.equal(inferDecisionKind("retrieval topology"), "family");
  assert.equal(inferDecisionKind("event bus architecture"), "family");
  assert.equal(inferDecisionKind("auth provider"), "concrete");
  assert.equal(inferDecisionKind("queue library"), "concrete");
  assert.equal(inferDecisionKind("logging vendor"), "concrete");
  assert.equal(inferDecisionKind("storage platform"), "concrete");
  assert.equal(inferDecisionKind("data lake design"), "family");
  // Edge cases.
  assert.equal(inferDecisionKind(""), "family");
  assert.equal(inferDecisionKind(undefined), "family");

  // Override via buildStrategicContext: caller passes decisionKind, the LLM
  // is called with that value, and the returned context carries it through.
  installProvider((label) => {
    if (label !== "strategic_context_extractor") {
      throw new Error(`decision-kind fixture: unexpected label ${label}`);
    }
    return {
      domain_entities: ["User"],
      bounded_contexts: ["AuthContext"],
      query_shapes: [{ name: "login", evidence: ["user logs in"] }],
      risk_invariants: ["Cross-tenant isolation"],
      operational_envelope: {
        latency: "not_specified",
        cost: "not_specified",
        scale: "not_specified",
        availability: "not_specified"
      },
      compliance_constraints: []
    };
  });

  const concreteCtx = await buildStrategicContext({
    sourcePath: "fixture.md",
    content: "Pick an auth provider for our multi-tenant SaaS.",
    domain: "multi-tenant SaaS",
    decision: "auth provider"
  });
  assert.equal(concreteCtx.decision_kind, "concrete", "decision_kind should auto-detect to concrete for 'auth provider'");

  const familyCtx = await buildStrategicContext({
    sourcePath: "fixture.md",
    content: "Pick a retrieval topology for our knowledge base.",
    domain: "kb",
    decision: "retrieval topology"
  });
  assert.equal(familyCtx.decision_kind, "family", "decision_kind should auto-detect to family for 'retrieval topology'");

  const overrideCtx = await buildStrategicContext({
    sourcePath: "fixture.md",
    content: "Pick a strategy.",
    domain: "x",
    decision: "auth provider",
    decisionKind: "family"   // explicit override beats auto-detection
  });
  assert.equal(overrideCtx.decision_kind, "family");

  setLlmJsonProvider(null);

  // Axes: concrete-mode adds pricing / lock-in / SDK / on-prem / ecosystem.
  const familyAxes = deriveComparisonAxes({
    decision_kind: "family",
    query_shapes: [],
    operational_envelope: { latency: "not_specified", cost: "not_specified", scale: "not_specified", availability: "not_specified" },
    compliance_constraints: []
  });
  const concreteAxes = deriveComparisonAxes({
    decision_kind: "concrete",
    query_shapes: [],
    operational_envelope: { latency: "not_specified", cost: "not_specified", scale: "not_specified", availability: "not_specified" },
    compliance_constraints: []
  });
  const vendorAxisIds = new Set([
    "pricing_model",
    "vendor_lock_in",
    "sdk_integration_quality",
    "on_prem_self_host",
    "ecosystem_health"
  ]);
  for (const id of vendorAxisIds) {
    assert.ok(
      concreteAxes.some((a) => a.id === id),
      `concrete-mode axes should include ${id}, got: ${concreteAxes.map((a) => a.id).join(", ")}`
    );
    assert.ok(
      !familyAxes.some((a) => a.id === id),
      `family-mode axes should NOT include ${id}, got: ${familyAxes.map((a) => a.id).join(", ")}`
    );
  }
}

// ---------------------------------------------------------------------------
// Clarification gate: PRD "Open questions" are folded into clarification,
// gate is blocking by default, --clarification-answers unblocks, --no-clarify
// opts out.
// ---------------------------------------------------------------------------

{
  // assessClarification merges PRD Open questions.
  const ctx = {
    domain: "saas",
    domain_entities: ["A", "B", "C", "D"],
    bounded_contexts: ["one"],
    query_shapes: [{ name: "q1" }, { name: "q2" }],
    operational_envelope: {
      latency: "100ms",
      cost: "not_specified",
      scale: "not_specified",
      availability: "not_specified"
    },
    compliance_constraints: ["audit"]
  };
  const prdContent = [
    "# Product Context: foo",
    "## Decision",
    "Pick X.",
    "## Open questions",
    "- What is the expected QPS?",
    "- What is the SLA?",
    "## Important constraints",
    "- something"
  ].join("\n");
  const result = assessClarification(ctx, prdContent);
  assert.equal(result.needs_clarification, true, "PRD Open questions should trigger the gate");
  const prdQs = result.questions.filter((q) => q.startsWith("From PRD Open questions:"));
  assert.equal(prdQs.length, 2, `expected 2 PRD questions, got: ${JSON.stringify(result.questions)}`);
  assert.ok(prdQs.some((q) => q.includes("QPS")));
  assert.ok(prdQs.some((q) => q.includes("SLA")));

  // No PRD Open questions section + enough context = no gate.
  const cleanCtx = {
    ...ctx,
    operational_envelope: { latency: "100ms", cost: "$1k/mo", scale: "10k qps", availability: "99.9%" }
  };
  const clean = assessClarification(cleanCtx, "# Product Context: foo\n\nbody only\n".padEnd(800, "x"));
  assert.equal(clean.needs_clarification, false);
}

{
  // prepareRun calls assertAgenticRuntime which checks for a live search
  // provider env var. Set a fake one for the gate-behavior test; restore at
  // the end so we do not pollute later tests.
  const priorTavily = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = priorTavily || "fixture-only";

  // prepareRun: gate blocks by default when PRD is thin.
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "adr-clarify-test-"));
  const thinPrdPath = path.join(tmpDir, "thin.md");
  await writeFile(
    thinPrdPath,
    "# Product Context\n\n## Decision\n\nPick something.\n\n## Open questions\n\n- What latency?\n- What scale?\n"
  );

  installProvider((label) => {
    if (label !== "strategic_context_extractor") {
      throw new Error(`prepareRun clarify fixture: unexpected label ${label}`);
    }
    return {
      domain_entities: [],
      bounded_contexts: [],
      query_shapes: [],
      risk_invariants: [],
      operational_envelope: {
        latency: "not_specified",
        cost: "not_specified",
        scale: "not_specified",
        availability: "not_specified"
      },
      compliance_constraints: []
    };
  });

  // Default = blocking.
  const blocked = await prepareRun({
    inputPath: thinPrdPath,
    flags: {
      domain: "saas",
      decision: "auth provider",
      out: path.join(tmpDir, "out-blocked")
    }
  });
  assert.equal(blocked.needsClarification, true, "thin PRD should block by default");
  assert.ok(blocked.clarification.questions.length > 0);
  assert.ok(
    blocked.clarification.questions.some((q) => q.startsWith("From PRD Open questions:")),
    "blocked clarification should include the PRD's Open questions"
  );

  // --no-clarify opts out.
  const opted = await prepareRun({
    inputPath: thinPrdPath,
    flags: {
      domain: "saas",
      decision: "auth provider",
      out: path.join(tmpDir, "out-noclarify"),
      "no-clarify": true
    }
  });
  assert.equal(opted.needsClarification, false, "--no-clarify should bypass the gate");

  // --clarification-answers unblocks and appends to content.
  const answered = await prepareRun({
    inputPath: thinPrdPath,
    flags: {
      domain: "saas",
      decision: "auth provider",
      out: path.join(tmpDir, "out-answered"),
      "clarification-answers":
        "Latency: 100ms p95. Scale: 10k qps. Compliance: SOC2."
    }
  });
  assert.equal(answered.needsClarification, false, "--clarification-answers should unblock");
  assert.ok(
    answered.content.includes("## Clarification answers"),
    "answers should be appended to content"
  );
  assert.ok(answered.content.includes("Latency: 100ms p95"));

  setLlmJsonProvider(null);
  await rm(tmpDir, { recursive: true, force: true });
  if (priorTavily === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = priorTavily;
}

// ---------------------------------------------------------------------------
// Source claim extractor: quote grounding + relevance filtering.
//
// The extractor is 75/92 LLM calls on a typical run — every downstream
// pathology traces back to claims that drift from what the source actually
// says. Two guardrails make this concrete:
//   1. `quote` MUST be a literal substring of the excerpt. Hallucinated
//      claims have no place to put their words, so they get dropped.
//   2. `relevance: off_topic` claims are dropped — a source that talks
//      about a different decision is not evidence for this one.
// ---------------------------------------------------------------------------

{
  const excerpt =
    "Clerk provides drop-in authentication for Next.js apps. It supports OAuth, MFA, and organizations. " +
    "Pricing starts at $25 per month after the free tier ends.";

  installProvider((label) => {
    if (label !== "source_claim_extractor") {
      throw new Error(`extractor fixture: unexpected label ${label}`);
    }
    return {
      claims: [
        // Valid: literal substring quote + on_topic + named product family.
        {
          claim: "Clerk has a Next.js drop-in.",
          quote: "Clerk provides drop-in authentication for Next.js apps.",
          architecture_family: "Clerk",
          polarity: "supports",
          relevance: "on_topic",
          confidence: 0.9
        },
        // Hallucinated quote — not in the excerpt. Should be dropped.
        {
          claim: "Clerk costs $5/mo.",
          quote: "Clerk is the cheapest option at five dollars per month.",
          architecture_family: "Clerk",
          polarity: "supports",
          relevance: "on_topic",
          confidence: 0.9
        },
        // Off-topic — talks about a different decision. Should be dropped.
        {
          claim: "Next.js is the preferred React framework.",
          quote: "drop-in authentication for Next.js apps",
          architecture_family: "Next.js",
          polarity: "supports",
          relevance: "off_topic",
          confidence: 0.9
        },
        // Empty quote. Should be dropped.
        {
          claim: "Some general claim",
          quote: "",
          architecture_family: "unspecified",
          polarity: "neutral",
          relevance: "on_topic",
          confidence: 0.5
        },
        // Quote with whitespace + smart quotes — normalization must still match.
        {
          claim: "MFA is supported.",
          quote: "It supports OAuth,    MFA, and organizations.",
          architecture_family: "Clerk",
          polarity: "supports",
          relevance: "on_topic",
          confidence: 0.85
        }
      ]
    };
  });

  const claims = await extractClaims({
    context: { domain: "saas", decision: "auth provider", decision_kind: "concrete" },
    task: { id: "t1", title: "auth", objective: "Compare auth providers" },
    source: {
      title: "Clerk docs",
      url: "https://clerk.com/docs",
      source_type: "official_docs",
      excerpt
    }
  });

  // Of the 5 input claims: 1 valid, 1 hallucinated, 1 off_topic, 1 empty quote,
  // 1 valid-with-whitespace-normalization. Expect 2 kept.
  assert.equal(claims.length, 2, `expected 2 kept claims, got: ${JSON.stringify(claims, null, 2)}`);
  assert.equal(claims[0].claim, "Clerk has a Next.js drop-in.");
  assert.equal(claims[0].relevance, "on_topic");
  assert.equal(claims[1].claim, "MFA is supported.");

  setLlmJsonProvider(null);
}

// ---------------------------------------------------------------------------
// Reframe to ranked_options:
//
// ADR no longer pretends to pick one architecture. The synthesizer produces
// a ranked option set with explicit tradeoffs, plus a recommendation only
// when one option clearly dominates. mode = "recommended" | "ranked_options"
// | "deferred". Guardrails are per-option (each option carries its own
// required_invariants and forbidden_topologies); the handoff lists every
// option as a separate contract.
// ---------------------------------------------------------------------------

{
  // Sub-test 1: synthesizer in mode=recommended produces a clean spec
  // where exactly one option is "selected" and its invariants roll up to
  // the back-compat top-level guardrails.

  installProvider((label) => {
    assert.equal(label, "architecture_synthesis_agent");
    return {
      decision: {
        id: "ADR-Auth",
        title: "Auth provider",
        status: "selected",
        mode: "recommended",
        ranked_options: [
          {
            name: "clerk",
            label: "Clerk",
            summary: "Drop-in auth for Next.js apps.",
            when_to_pick: ["You want low integration time", "MFA + organizations matter out of the box"],
            when_not_to_pick: ["You require on-prem deployment"],
            strong_axes: ["pricing_model", "sdk_integration_quality"],
            weak_axes: ["on_prem_self_host"],
            risks: ["Vendor lock-in"],
            required_invariants: ["Tokens must be issued by Clerk's session API"],
            forbidden_topologies: ["roll_your_own_jwt"],
            evidence_citations: [1, 2],
            confidence: 0.9
          },
          {
            name: "auth0",
            label: "Auth0",
            summary: "Mature OAuth-first provider.",
            when_to_pick: ["You need enterprise SSO/SAML"],
            when_not_to_pick: ["You are price-sensitive at scale"],
            strong_axes: ["sdk_integration_quality"],
            weak_axes: ["pricing_model"],
            risks: ["Costs scale poorly"],
            required_invariants: ["Use Auth0 Rules for tenant gating"],
            forbidden_topologies: ["self_host_session_store"],
            evidence_citations: [3],
            confidence: 0.7
          }
        ],
        recommendation: {
          name: "clerk",
          why: "Clerk is strong on the two axes that matter most for this multi-tenant Next.js app.",
          when_this_breaks: ["You decide you must self-host"]
        },
        summary: "Clerk recommended; Auth0 retained as a viable alternative.",
        evidence_citations: [1, 2, 3]
      },
      domain_model: {
        bounded_contexts: ["AuthContext"],
        core_entities: ["User"],
        domain_invariants: []
      },
      evidence_summary: { allowed_agentic_use: ["onboarding"] }
    };
  });

  // Knowledge map: simulate two promoted candidates (clerk + auth0).
  const km = {
    promotion_rule: "test rule",
    promoted_candidates: [
      { name: "clerk", label: "Clerk", citations: [1, 2], evidence_count: 2 },
      { name: "auth0", label: "Auth0", citations: [3], evidence_count: 1 }
    ],
    insufficient_evidence_candidates: []
  };
  const evidence = [
    { citation_id: 1, title: "Clerk docs", url: "https://clerk.com", source_type: "official_docs", score: 0.9, excerpt: "...", claims: [], relevance: "x" },
    { citation_id: 2, title: "Clerk pricing", url: "https://clerk.com/pricing", source_type: "official_docs", score: 0.7, excerpt: "...", claims: [], relevance: "x" },
    { citation_id: 3, title: "Auth0 docs", url: "https://auth0.com", source_type: "official_docs", score: 0.8, excerpt: "...", claims: [], relevance: "x" }
  ];

  const spec = await synthesizeDecisionPhase({
    context: {
      domain: "saas",
      decision: "auth provider",
      decision_kind: "concrete",
      domain_entities: ["User"],
      bounded_contexts: ["AuthContext"],
      query_shapes: [],
      operational_envelope: {
        latency: "not_specified",
        cost: "not_specified",
        scale: "not_specified",
        availability: "not_specified"
      },
      compliance_constraints: [],
      risk_invariants: []
    },
    knowledgeMap: km,
    evidenceItems: evidence,
    comparisonMatrix: null
  });

  assert.equal(spec.decision.mode, "recommended");
  assert.equal(spec.decision.recommendation.name, "clerk");
  assert.equal(spec.decision.ranked_options.length, 2);
  assert.equal(spec.decision.selected_topology, "clerk", "selected_topology back-compat should equal recommendation.name");
  // Both ranked options must appear in candidate_topologies; the recommended
  // one with decision: "selected", the other with decision: "considered".
  const candByName = Object.fromEntries(spec.candidate_topologies.map((c) => [c.name, c]));
  assert.equal(candByName.clerk.decision, "selected");
  assert.equal(candByName.auth0.decision, "considered");
  // Back-compat roll-up: top-level guardrails mirror the recommended option.
  assert.deepEqual(spec.guardrails.required_invariants, ["Tokens must be issued by Clerk's session API"]);
  assert.deepEqual(spec.guardrails.forbidden_topologies, ["roll_your_own_jwt"]);

  // Per-option guardrails markdown contains BOTH options, each with its own
  // invariants block. The recommended option carries the (recommended) tag.
  const guardrailsMd = buildGuardrails(spec);
  assert.ok(guardrailsMd.includes("Option: `clerk`"), "guardrails should list option clerk");
  assert.ok(guardrailsMd.includes("Option: `auth0`"), "guardrails should list option auth0");
  assert.ok(guardrailsMd.includes("*(recommended)*"), "recommended option should be tagged");
  assert.ok(
    guardrailsMd.includes("Tokens must be issued by Clerk's session API"),
    "clerk's per-option invariant must appear"
  );
  assert.ok(
    guardrailsMd.includes("Use Auth0 Rules for tenant gating"),
    "auth0's per-option invariant must appear"
  );

  setLlmJsonProvider(null);
}

{
  // Sub-test 2: synthesizer in mode=ranked_options — two viable options,
  // no recommendation. This is the correct default for genuine tradeoffs.

  installProvider((label) => {
    assert.equal(label, "architecture_synthesis_agent");
    return {
      decision: {
        id: "ADR-Retrieval",
        title: "Retrieval Topology",
        status: "proposed",
        mode: "ranked_options",
        ranked_options: [
          {
            name: "graphrag",
            label: "GraphRAG",
            summary: "Graph-based retrieval over hierarchical communities.",
            when_to_pick: ["Multi-hop entity reasoning matters"],
            when_not_to_pick: ["Single-hop QA only"],
            strong_axes: ["multi_hop_relational"],
            weak_axes: ["index_build_cost"],
            required_invariants: ["Preserve community hierarchy"],
            forbidden_topologies: ["pure_vector_retrieval"],
            evidence_citations: [1],
            confidence: 0.7
          },
          {
            name: "vector_rag",
            label: "Vector RAG",
            summary: "Top-K vector search with reranking.",
            when_to_pick: ["High-volume single-hop QA"],
            when_not_to_pick: ["Multi-hop entity reasoning matters"],
            strong_axes: ["index_build_cost"],
            weak_axes: ["multi_hop_relational"],
            required_invariants: ["Cite source IDs in answers"],
            forbidden_topologies: ["unsupervised_clustering"],
            evidence_citations: [2],
            confidence: 0.6
          }
        ],
        recommendation: null,
        summary: "Two viable retrieval topologies with genuine tradeoffs.",
        evidence_citations: []
      },
      domain_model: {},
      evidence_summary: {}
    };
  });

  const km2 = {
    promotion_rule: "test",
    promoted_candidates: [
      { name: "graphrag", label: "GraphRAG", citations: [1], evidence_count: 1 },
      { name: "vector_rag", label: "Vector RAG", citations: [2], evidence_count: 1 }
    ],
    insufficient_evidence_candidates: []
  };
  const evidence2 = [
    { citation_id: 1, title: "graphrag paper", url: "https://...", source_type: "paper_or_benchmark", score: 0.9, excerpt: "...", claims: [], relevance: "x" },
    { citation_id: 2, title: "vectorrag", url: "https://...", source_type: "official_docs", score: 0.8, excerpt: "...", claims: [], relevance: "x" }
  ];

  const spec = await synthesizeDecisionPhase({
    context: {
      domain: "kb",
      decision: "retrieval topology",
      decision_kind: "family",
      domain_entities: [],
      bounded_contexts: [],
      query_shapes: [],
      operational_envelope: {
        latency: "not_specified",
        cost: "not_specified",
        scale: "not_specified",
        availability: "not_specified"
      },
      compliance_constraints: [],
      risk_invariants: []
    },
    knowledgeMap: km2,
    evidenceItems: evidence2,
    comparisonMatrix: null
  });

  assert.equal(spec.decision.mode, "ranked_options");
  assert.equal(spec.decision.recommendation, null);
  assert.equal(spec.decision.ranked_options.length, 2);
  // selected_topology takes the literal "ranked_options" sentinel — NOT
  // requires_human_architecture_review. The two are different signals.
  assert.equal(spec.decision.selected_topology, "ranked_options");
  // Both options should appear as "considered" (none "selected") because
  // there is no recommendation.
  for (const c of spec.candidate_topologies) {
    assert.equal(c.decision, "considered");
  }
  // Top-level guardrails are EMPTY when no recommendation — callers must
  // read per-option from ranked_options.
  assert.deepEqual(spec.guardrails.required_invariants, []);
  assert.deepEqual(spec.guardrails.forbidden_topologies, []);

  // Guardrails: per-option blocks, "No recommendation" framing visible.
  const guardrailsMd = buildGuardrails(spec);
  assert.ok(guardrailsMd.includes("Option: `graphrag`"));
  assert.ok(guardrailsMd.includes("Option: `vector_rag`"));
  assert.ok(guardrailsMd.includes("No recommendation"));
  assert.ok(!guardrailsMd.includes("*(recommended)*"));

  setLlmJsonProvider(null);
}

// ---------------------------------------------------------------------------
// classifySource: aggregator domains must NOT be promoted to engineering_writeup
// just because their URL contains "blog" or "engineering".
// ---------------------------------------------------------------------------

{
  // Aggregators caught even when /blog/ is in the path:
  assert.equal(classifySource("https://www.geeksforgeeks.org/blog/system-design"), "aggregator");
  assert.equal(classifySource("https://www.tutorialspoint.com/engineering"), "aggregator");
  assert.equal(classifySource("https://www.javatpoint.com/auth-providers-blog"), "aggregator");

  // Real engineering blogs still classify correctly:
  assert.equal(classifySource("https://engineering.linear.app/architecture-decisions"), "engineering_writeup");
  assert.equal(classifySource("https://stripe.com/blog/the-payment-graph"), "engineering_writeup");

  // Official docs / OSS / papers unaffected:
  assert.equal(classifySource("https://docs.clerk.com/quickstart"), "official_docs");
  assert.equal(classifySource("https://github.com/supertokens/supertokens-core"), "mature_oss");
  assert.equal(classifySource("https://arxiv.org/abs/2402.12345"), "paper_or_benchmark");

  // Falls through to general_web when nothing matches:
  assert.equal(classifySource("https://random-corp.example.com/posts"), "general_web");
}

console.log("kernel regression tests ok");
