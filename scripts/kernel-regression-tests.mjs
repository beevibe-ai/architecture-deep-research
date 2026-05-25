#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { mkdir, writeFile } from "node:fs/promises";

import {
  applyCitationAudit,
  assessClarification,
  buildADR,
  buildGuardrails,
  buildKnowledgeMap,
  buildStrategicContext,
  buildAdversarialResearchPlan,
  classifySource,
  critiqueDecisionPhase,
  deriveComparisonAxes,
  discoverPatterns,
  discoverPrinciples,
  reviewDiff,
  guard,
  extractClaims,
  extractDecisionContext,
  filterPromotedByRelevance,
  generateHandoff,
  injectDiscoveredEvidence,
  openUrl,
  prepareRun,
  proposeFollowUpQuestions,
  setLlmJsonProvider,
  synthesizeDecisionPhase,
  validateMermaidSource,
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

  // Every family with at least one evidence claim becomes a candidate now —
  // the old evidence-depth promotion gate is gone. Off-topic candidates are
  // still filtered (none here, so candidates = 1).
  assert.equal(knowledgeMap.candidates.length, 1);
  assert.equal(knowledgeMap.candidates[0].name, "graphrag");
  assert.equal(knowledgeMap.candidates[0].support.length, 2);
  assert.equal(knowledgeMap.candidates[0].evidence_depth, "medium");
  assert.equal(Number.isFinite(knowledgeMap.candidates[0].score), true);

  installProvider((label) => {
    assert.equal(label, "research_report_agent");
    // The synthesizer tries to invent "invented_topology" which is NOT in
    // candidates; the parser must drop it from options.
    return {
      id: "ADR-X",
      title: "Retrieval Topology",
      executive_summary: "Empty pool — no candidates surfaced.",
      options: [
        {
          name: "invented_topology",
          label: "Invented",
          summary: "Looks plausible but is not in the candidate set.",
          evidence_depth: "thin",
          what_evidence_shows: "",
          what_evidence_does_not_show: "",
          strong_axes: [],
          weak_axes: [],
          when_to_pick: [],
          when_not_to_pick: [],
          citations: [999]
        }
      ],
      cross_cutting_tradeoffs: [],
      open_questions: [],
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

  // No candidates → invented option gets filtered → options is empty.
  assert.deepEqual(gatedSpec.options, []);
  assert.equal(gatedSpec.id, "ADR-X");

  // applyCritique / applyCitationAudit are no-ops in the report engine —
  // they preserve the spec unchanged. Verify that contract.
  const passthrough = applyCitationAudit({
    spec: gatedSpec,
    citationAudit: {
      items: [
        {
          citation_id: 1,
          claim_context: "candidate:graphrag",
          verified: false,
          confidence: 0.1,
          reason: "unsupported"
        }
      ]
    },
    flags: {}
  });
  assert.equal(passthrough.downgraded, false);
  assert.equal(passthrough.spec, gatedSpec, "applyCitationAudit must return the spec unchanged");

  installProvider((label) => {
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
      version: "0.3.0",
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
      version: "0.3.0",
      id: "ADR-001",
      title: "Retrieval Topology",
      executive_summary: "GraphRAG surfaced in the evidence pool.",
      option_space_shape: "Single-candidate space.",
      options: [
        {
          name: "graphrag",
          label: "GraphRAG",
          summary: "Preserves explicit relationships.",
          evidence_depth: "medium",
          what_evidence_shows: "Citations show multi-hop retrieval.",
          what_evidence_does_not_show: "No production scale data.",
          strong_axes: ["multi_hop_relational"],
          weak_axes: [],
          when_to_pick: ["multi-hop reasoning"],
          when_not_to_pick: ["pure single-hop"],
          citations: [1]
        }
      ],
      cross_cutting_tradeoffs: [],
      open_questions: ["What does production scale look like?"],
      domain_model: {
        bounded_contexts: ["KnowledgeGraphContext"],
        core_entities: ["Contract", "Vendor"],
        domain_invariants: ["Answers must resolve to source-backed evidence before being returned."]
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

  // Default-path artifacts: research-report.json + ADR.md + research-report.md
  // + sources.md. Handoff artifacts (agent-guardrails.md, execution-handoff.json,
  // domain-evaluation-pack.json) are SKIPPED by default — they're produced by
  // `adr handoff <out_dir> --option <name>`.
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(path.join(outDir, "research-report.json")), "research-report.json must be written");
  assert.ok(existsSync(path.join(outDir, "ADR.md")), "ADR.md must be written");
  assert.ok(!existsSync(path.join(outDir, "agent-guardrails.md")), "agent-guardrails.md must NOT be written on default path");
  assert.ok(!existsSync(path.join(outDir, "execution-handoff.json")), "execution-handoff.json must NOT be written on default path");
  assert.ok(!existsSync(path.join(outDir, "domain-evaluation-pack.json")), "domain-evaluation-pack.json must NOT be written on default path");

  await rm(outDir, { recursive: true, force: true });
} finally {
  setLlmJsonProvider(null);
}

// ---------------------------------------------------------------------------
// Critique categories (research-report engine):
// The critique now evaluates report comprehensiveness, not recommendation
// defensibility. New categories include missing_candidate_section,
// imbalanced_evidence_depth, weak_citation, missing_open_question, etc.
// ---------------------------------------------------------------------------

{
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "adr-critique-test-"));

  installProvider((label) => {
    assert.equal(label, "research_report_critique_agent");
    return {
      issues: [
        {
          severity: "high",
          category: "missing_candidate_section",
          description: "candidate `weaviate` is in knowledge_map.candidates but no options entry exists.",
          evidence_citations: [],
          target: { kind: "report" }
        },
        {
          severity: "medium",
          category: "imbalanced_evidence_depth",
          description: "pgvector is thick but pinecone is thin; executive_summary doesn't acknowledge this.",
          evidence_citations: [],
          target: { kind: "report" }
        }
      ],
      summary: "One missing candidate section + imbalanced depth not acknowledged.",
      recommend_human_review: false
    };
  });

  const spec = {
    version: "0.3.0",
    id: "ADR-1",
    title: "Vector store",
    executive_summary: "Two candidates surfaced.",
    options: [
      { name: "pgvector", label: "pgvector", evidence_depth: "thick", citations: [1] },
      { name: "pinecone", label: "Pinecone", evidence_depth: "thin", citations: [2] }
    ]
  };
  const km = {
    acquisition_rule: "test",
    candidates: [
      { name: "pgvector", label: "pgvector", evidence_depth: "thick", citations: [1], evidence_count: 5, support: [] },
      { name: "pinecone", label: "Pinecone", evidence_depth: "thin", citations: [2], evidence_count: 1, support: [] },
      { name: "weaviate", label: "Weaviate", evidence_depth: "medium", citations: [3], evidence_count: 3, support: [] }
    ],
    off_topic_candidates: []
  };

  const critique = await critiqueDecisionPhase({
    context: { domain: "saas", decision: "vector store" },
    spec,
    knowledgeMap: km,
    evidenceItems: [
      { citation_id: 1, title: "a", url: "https://x", source_type: "official_docs", score: 1, claims: [] },
      { citation_id: 2, title: "b", url: "https://y", source_type: "official_docs", score: 1, claims: [] },
      { citation_id: 3, title: "c", url: "https://z", source_type: "official_docs", score: 1, claims: [] }
    ],
    outDir: tmpDir
  });

  assert.equal(critique.issues.length, 2);
  assert.equal(critique.high_severity_count, 1);
  const categories = new Set(critique.issues.map((i) => i.category));
  assert.ok(categories.has("missing_candidate_section"), "missing_candidate_section must be present");
  assert.ok(categories.has("imbalanced_evidence_depth"), "imbalanced_evidence_depth must be present");

  setLlmJsonProvider(null);
  await rm(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// `adr handoff <out_dir> --option <name>`: lazy handoff that reads an
// existing research-report.json, scopes to one candidate, and writes
// agent-guardrails.md + execution-handoff.json (and optionally
// domain-evaluation-pack.json when --write-evaluation-pack is set).
// ---------------------------------------------------------------------------

{
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "adr-handoff-test-"));
  // Pre-create a research-report.json on disk.
  const report = {
    version: "0.3.0",
    id: "ADR-Vector",
    title: "Vector store",
    executive_summary: "Two candidates.",
    option_space_shape: "split between OSS and managed.",
    options: [
      {
        name: "pgvector",
        label: "pgvector",
        summary: "Postgres extension.",
        evidence_depth: "thick",
        what_evidence_shows: "x",
        what_evidence_does_not_show: "y",
        strong_axes: ["fits_existing_stack"],
        weak_axes: [],
        when_to_pick: ["Postgres in stack"],
        when_not_to_pick: ["No Postgres"],
        citations: [1]
      },
      {
        name: "pinecone",
        label: "Pinecone",
        summary: "Managed vector DB.",
        evidence_depth: "medium",
        what_evidence_shows: "x",
        what_evidence_does_not_show: "y",
        strong_axes: ["latency"],
        weak_axes: ["self_host"],
        when_to_pick: ["managed cloud OK"],
        when_not_to_pick: ["self-hosted only"],
        citations: [2]
      }
    ],
    cross_cutting_tradeoffs: [],
    open_questions: []
  };
  await writeJson(path.join(tmpDir, "research-report.json"), report);

  const { existsSync } = await import("node:fs");

  // Generate handoff for pgvector.
  const result = await generateHandoff({
    outDir: tmpDir,
    optionName: "pgvector",
    flags: {}
  });
  assert.equal(result.status, "completed");
  assert.equal(result.chosen_option, "pgvector");
  assert.ok(existsSync(path.join(tmpDir, "agent-guardrails.md")));
  assert.ok(existsSync(path.join(tmpDir, "execution-handoff.json")));
  // Evaluation pack NOT generated unless --write-evaluation-pack is set.
  assert.ok(!existsSync(path.join(tmpDir, "domain-evaluation-pack.json")));

  // Verify the handoff json is scoped to one option.
  const handoff = JSON.parse(await readFile(path.join(tmpDir, "execution-handoff.json"), "utf8"));
  assert.equal(handoff.chosen_option, "pgvector");
  assert.equal(handoff.options.length, 1);
  assert.equal(handoff.options[0].name, "pgvector");

  // Verify guardrails markdown is scoped to one option.
  const guardrailsMd = await readFile(path.join(tmpDir, "agent-guardrails.md"), "utf8");
  assert.ok(guardrailsMd.includes("Option: `pgvector`"));
  assert.ok(!guardrailsMd.includes("Option: `pinecone`"));

  // Asking for a non-existent option must throw a helpful error.
  await assert.rejects(
    async () => {
      await generateHandoff({
        outDir: tmpDir,
        optionName: "milvus",
        flags: {}
      });
    },
    /Option "milvus" not found/
  );

  await rm(tmpDir, { recursive: true, force: true });
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
// Principles-stage regression: build a tiny fake repo, install fixtures for
// the four principles labels, run discoverPrinciples in --non-interactive
// mode, and verify principles.json + principles.md land on disk with the
// expected shape and event log.
// ---------------------------------------------------------------------------

try {
  const principlesOutDir = await mkdtemp(
    path.join(os.tmpdir(), "adr-principles-test-")
  );
  const fakeRepoDir = await mkdtemp(
    path.join(os.tmpdir(), "adr-principles-repo-")
  );

  await writeFile(
    path.join(fakeRepoDir, "README.md"),
    [
      "# fake-repo",
      "",
      "Tiny synthetic repo for the principles regression test.",
      "",
      "## Conventions",
      "- State lives in /stores via Zustand.",
      "- No useState for cross-component selections."
    ].join("\n")
  );
  await writeFile(
    path.join(fakeRepoDir, "package.json"),
    JSON.stringify(
      {
        name: "fake-repo",
        type: "module",
        dependencies: { zustand: "^4.0.0" }
      },
      null,
      2
    )
  );
  await mkdir(path.join(fakeRepoDir, "stores"), { recursive: true });
  await writeFile(
    path.join(fakeRepoDir, "stores", "chatStore.ts"),
    "// canonical zustand store\nexport const useChatStore = () => null;\n"
  );

  installProvider((label) => {
    if (label === "principles_lens_discovery") {
      return {
        lenses: [
          {
            slug: "state-boundaries",
            name: "State boundaries",
            rationale:
              "Repo uses Zustand and declares state conventions in README.",
            scan_signals: ["package.json", "README.md", "stores/chatStore.ts"]
          }
        ]
      };
    }
    if (label === "principles_pattern_extractor") {
      return {
        positive_patterns: [
          {
            name: "state_via_zustand_stores",
            rule: "State lives in /stores via Zustand, not in component-local useState.",
            evidence_cite: ["stores/chatStore.ts:1", "README.md"],
            why: "README declares it; chatStore.ts demonstrates it."
          }
        ],
        antipatterns: [],
        ambiguities: []
      };
    }
    if (label === "principles_interview_generator") {
      return { questions: [] };
    }
    if (label === "principles_consolidator") {
      return {
        principles: [
          {
            id: "state-via-zustand-stores",
            lens: "state-boundaries",
            polarity: "do",
            rule: "State lives in /stores via Zustand.",
            rationale: "Team convention declared in README + chatStore.ts.",
            evidence_cite: ["stores/chatStore.ts:1", "README.md"],
            examples_to_follow: ["stores/chatStore.ts:1"],
            examples_to_avoid: [],
            confirmed_by_interview: false,
            confidence: "high"
          }
        ]
      };
    }
    throw new Error(
      `principles regression fixture: unexpected label ${label}`
    );
  });

  const result = await discoverPrinciples({
    flags: {
      repo: fakeRepoDir,
      out: principlesOutDir,
      "non-interactive": true
    }
  });

  assert.equal(result.lenses.length, 1);
  assert.equal(result.lenses[0].slug, "state-boundaries");
  assert.equal(result.principles.length, 1);
  assert.equal(result.principles[0].id, "state-via-zustand-stores");
  assert.equal(result.principles[0].polarity, "do");
  // After #8 (deterministic confidence grading), non-interactive runs
  // with >=2 evidence cites land at "medium" by rule. "high" requires
  // confirmed_by_interview=true.
  assert.equal(result.principles[0].confidence, "medium");
  assert.equal(result.interviewLog.length, 0);

  const persisted = JSON.parse(
    await readFile(path.join(principlesOutDir, "principles.json"), "utf8")
  );
  assert.equal(persisted.lenses.length, 1);
  assert.equal(persisted.principles.length, 1);
  assert.ok(
    persisted.principles[0].evidence_cite.includes("stores/chatStore.ts:1")
  );

  const markdown = await readFile(
    path.join(principlesOutDir, "principles.md"),
    "utf8"
  );
  assert.ok(markdown.includes("# Team principles"));
  assert.ok(markdown.includes("State boundaries"));
  assert.ok(markdown.includes("DO: State lives in /stores via Zustand."));

  const events = (
    await readFile(path.join(principlesOutDir, "events.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const eventTypes = events.map((event) => event.type);
  assert.deepEqual(eventTypes, [
    "principles_started",
    "repo_scanned",
    "source_sampled",
    "lenses_discovered",
    "lens_patterns_extracted",
    "interview_skipped",
    "principles_consolidated",
    "citations_verified",
    "principles_emitted",
    "principles_completed"
  ]);

  await rm(principlesOutDir, { recursive: true, force: true });
  await rm(fakeRepoDir, { recursive: true, force: true });
} finally {
  setLlmJsonProvider(null);
}

// ---------------------------------------------------------------------------
// Review-stage regression: stage a fake repo with .adr/principles.json plus
// a synthetic unified diff, install a fixture for the violation-detector
// label, run reviewDiff in non-interactive mode, and verify the structured
// violation artifact lands on disk.
// ---------------------------------------------------------------------------

try {
  const reviewRepoDir = await mkdtemp(
    path.join(os.tmpdir(), "adr-review-repo-")
  );
  const diffPath = path.join(reviewRepoDir, "change.patch");

  // Stage a principles.json that the review will load.
  await mkdir(path.join(reviewRepoDir, ".adr"), { recursive: true });
  await writeJson(path.join(reviewRepoDir, ".adr", "principles.json"), {
    version: "test",
    source: {
      repo_path: reviewRepoDir,
      scanned_at: "2026-05-25T00:00:00.000Z",
      interview_completed: true
    },
    lenses: [
      {
        slug: "state-boundaries",
        name: "State boundaries",
        rationale: "State lives in Zustand stores, not useState."
      }
    ],
    principles: [
      {
        id: "state-via-zustand-stores",
        lens: "state-boundaries",
        polarity: "do",
        rule: "State lives in /stores via Zustand.",
        rationale: "Cross-component state belongs in the store.",
        evidence_cite: ["stores/chatStore.ts:14"],
        examples_to_follow: ["stores/chatStore.ts:14"],
        examples_to_avoid: [],
        confirmed_by_interview: true,
        confidence: "high"
      }
    ],
    interview_log: []
  });

  // Synthetic unified diff: one file, one hunk, one offending addition.
  const diff = [
    "diff --git a/web/src/components/ChatHeader.tsx b/web/src/components/ChatHeader.tsx",
    "index 1111111..2222222 100644",
    "--- a/web/src/components/ChatHeader.tsx",
    "+++ b/web/src/components/ChatHeader.tsx",
    "@@ -1,6 +1,8 @@",
    " import React from \"react\";",
    " ",
    " export function ChatHeader() {",
    "+  const [selectedAgentId, setSelectedAgentId] = React.useState(null);",
    "+  // rebuilds state in TSX instead of using chatStore",
    "   return <div>header</div>;",
    " }",
    ""
  ].join("\n");
  await writeFile(diffPath, diff);

  installProvider((label) => {
    if (label === "review_violation_detector") {
      return {
        violations: [
          {
            principle_id: "state-via-zustand-stores",
            file: "web/src/components/ChatHeader.tsx",
            line: 4,
            severity: "high",
            message:
              "Adds component-local useState for selectedAgentId. Cross-component selections live in chatStore.",
            suggested_fix:
              "Move `selectedAgentId` to chatStore.ts:14 and expose via useSelectedAgent()."
          }
        ]
      };
    }
    throw new Error(
      `review regression fixture: unexpected label ${label}`
    );
  });

  const result = await reviewDiff({
    flags: {
      repo: reviewRepoDir,
      diff: diffPath,
      "non-interactive": true
    }
  });

  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].principle_id, "state-via-zustand-stores");
  assert.equal(result.violations[0].severity, "high");
  assert.equal(result.violations[0].line, 4);
  assert.equal(result.filesReviewed.length, 1);
  assert.equal(
    result.filesReviewed[0],
    "web/src/components/ChatHeader.tsx"
  );

  const persisted = JSON.parse(
    await readFile(path.join(result.outDir, "review.json"), "utf8")
  );
  assert.equal(persisted.violations.length, 1);
  assert.equal(persisted.source.kind, "file");
  assert.equal(persisted.files_reviewed.length, 1);

  const events = (
    await readFile(path.join(result.outDir, "events.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const eventTypes = events.map((event) => event.type);
  assert.deepEqual(eventTypes, [
    "review_started",
    "principles_loaded",
    "principles_health_checked",
    "diff_parsed",
    "suppressions_applied",
    "violations_detected",
    "principle_stats_updated",
    "review_completed"
  ]);

  // Stats artifact should have one entry — the offending principle.
  const stats = JSON.parse(
    await readFile(
      path.join(reviewRepoDir, ".adr", "principle-stats.json"),
      "utf8"
    )
  );
  assert.equal(
    stats.by_principle["state-via-zustand-stores"].accepted,
    1
  );
  assert.equal(
    stats.by_principle["state-via-zustand-stores"].total_seen,
    1
  );

  // The health check should have written principles-health.json next to
  // the principles file. In this test, the cited path
  // "stores/chatStore.ts:14" was NOT created on disk in the fake repo,
  // so it should land in stale_citation_count.
  const healthArtifact = JSON.parse(
    await readFile(
      path.join(reviewRepoDir, ".adr", "principles-health.json"),
      "utf8"
    )
  );
  assert.equal(healthArtifact.total_principles, 1);
  assert.ok(healthArtifact.total_citations >= 1);
  // The lone principle in this test cites a file that doesn't exist,
  // so it should be flagged as stale.
  assert.equal(healthArtifact.stale_principle_count, 1);
  assert.equal(healthArtifact.by_principle[0].is_stale, true);

  await rm(reviewRepoDir, { recursive: true, force: true });
} finally {
  setLlmJsonProvider(null);
}

// ---------------------------------------------------------------------------
// Guard-stage regression: exercises the pure filter (pickRelevantPrinciples)
// + the install logic (idempotency, file shape). The pre-write hook
// integration with stdin/stdout is covered by the smoke test instead.
// ---------------------------------------------------------------------------

{
  const { pickRelevantPrinciples } = await import("../src/guard/pre-write.mjs");
  const { installGuards } = await import("../src/guard/install.mjs");

  // Filter test: pick the principles whose example_to_follow shares a
  // top-level dir with the edited file, plus broadly-applicable lenses.
  const principles = [
    {
      id: "schema-validate-before-write",
      lens: "schema-validate-before-write",
      polarity: "do",
      rule: "Validate JSON before writeJson()",
      examples_to_follow: ["src/kernel.mjs:3000"],
      confirmed_by_interview: true,
      confidence: "high"
    },
    {
      id: "state-via-stores",
      lens: "state-boundaries",
      polarity: "do",
      rule: "State lives in /stores",
      examples_to_follow: ["web/src/stores/chatStore.ts:14"],
      confirmed_by_interview: true,
      confidence: "high"
    },
    {
      id: "scripts-pattern",
      lens: "cli-subcommand-pattern",
      polarity: "do",
      rule: "New CLI subcommands attach in scripts/adr.mjs",
      examples_to_follow: ["scripts/adr.mjs:10"],
      confirmed_by_interview: true,
      confidence: "high"
    }
  ];

  // Editing a file under /web/ should match the state-via-stores principle
  // (same top-level), plus schema-validate-before-write (broad lens).
  const webEdits = pickRelevantPrinciples(
    principles,
    "web/src/components/ChatHeader.tsx"
  );
  const webIds = webEdits.map((p) => p.id);
  assert.ok(webIds.includes("state-via-stores"), "state-via-stores should fire for web/ edit");
  assert.ok(webIds.includes("schema-validate-before-write"), "broad lens should fire");
  assert.ok(!webIds.includes("scripts-pattern"), "scripts/ principle should not fire on web/ edit");

  // Editing a file under /scripts/ should match scripts-pattern + the broad
  // schema-validate lens; state-via-stores should not fire.
  const scriptsEdits = pickRelevantPrinciples(
    principles,
    "scripts/adr.mjs"
  );
  const scriptsIds = scriptsEdits.map((p) => p.id);
  assert.ok(scriptsIds.includes("scripts-pattern"));
  assert.ok(scriptsIds.includes("schema-validate-before-write"));
  assert.ok(!scriptsIds.includes("state-via-stores"));

  // Install test: idempotent, shape correct.
  const guardRepo = await mkdtemp(path.join(os.tmpdir(), "adr-guard-install-"));
  // Stage a `.git` directory so the pre-commit branch runs.
  await mkdir(path.join(guardRepo, ".git", "hooks"), { recursive: true });
  const r1 = await installGuards({ repoPath: guardRepo });
  assert.equal(r1.claude.added, true);
  assert.equal(r1.precommit.added, true);
  const settings = JSON.parse(
    await readFile(path.join(guardRepo, ".claude", "settings.local.json"), "utf8")
  );
  assert.ok(Array.isArray(settings.hooks?.PreToolUse));
  assert.ok(
    settings.hooks.PreToolUse.some((entry) =>
      entry.hooks?.some((h) => h.command === "adr guard pre-write")
    )
  );
  const precommit = await readFile(
    path.join(guardRepo, ".git", "hooks", "pre-commit"),
    "utf8"
  );
  assert.ok(precommit.includes("adr guard pre-commit"));
  assert.ok(precommit.startsWith("#!/bin/sh"));

  // Re-run should be a no-op.
  const r2 = await installGuards({ repoPath: guardRepo });
  assert.equal(r2.claude.added, false);
  assert.equal(r2.precommit.added, false);

  await rm(guardRepo, { recursive: true, force: true });
}

// guard export sanity (the lazy import works end-to-end without throwing
// before the guard sub-action runs).
assert.equal(typeof guard, "function");

// ---------------------------------------------------------------------------
// Pure-logic coverage for the modules shipped in roadmap #1-#12. These
// don't need an LLM fixture — they test deterministic behavior.
// ---------------------------------------------------------------------------

{
  // refresh-merge: filename overlap matching + ID match
  const { mergePrinciples, citeOverlap } = await import(
    "../src/principles/refresh-merge.mjs"
  );

  const priorPrinciples = [
    {
      id: "schema-validate",
      lens: "validation",
      polarity: "do",
      rule: "Validate before write",
      evidence_cite: ["src/kernel.mjs:42", "src/kernel.mjs:50"],
      examples_to_follow: [],
      confirmed_by_interview: true,
      confidence: "high"
    },
    {
      id: "use-stores",
      lens: "state",
      polarity: "do",
      rule: "State in stores",
      evidence_cite: ["web/stores/chatStore.ts:14"],
      examples_to_follow: [],
      confirmed_by_interview: false,
      confidence: "medium"
    }
  ];

  // Exact-id match should inherit confirmation.
  const newOne = [
    {
      id: "schema-validate",
      lens: "validation",
      polarity: "do",
      rule: "Validate before write (rephrased)",
      evidence_cite: ["src/kernel.mjs:100"],
      examples_to_follow: [],
      confirmed_by_interview: false,
      confidence: "medium"
    }
  ];
  const { merged: m1 } = mergePrinciples(newOne, priorPrinciples);
  assert.equal(m1[0].confirmed_by_interview, true);
  assert.equal(m1[0].confidence, "high");
  assert.equal(m1[0].rule, "Validate before write (rephrased)");

  // Filename-overlap match (different id, shared filename)
  const renamedNew = [
    {
      id: "validate-json-before-persist",
      lens: "validation",
      polarity: "do",
      rule: "Use writeJson() helper",
      evidence_cite: ["src/kernel.mjs:100", "src/kernel.mjs:101"],
      examples_to_follow: [],
      confirmed_by_interview: false,
      confidence: "medium"
    }
  ];
  const { merged: m2 } = mergePrinciples(renamedNew, priorPrinciples);
  assert.equal(m2[0].confirmed_by_interview, true);

  // No match (different file entirely): stays new
  const orphan = [
    {
      id: "brand-new",
      lens: "new-lens",
      polarity: "do",
      rule: "New rule",
      evidence_cite: ["unrelated/path.ts:1"],
      examples_to_follow: [],
      confirmed_by_interview: false,
      confidence: "medium"
    }
  ];
  const { merged: m3, stats } = mergePrinciples(orphan, priorPrinciples);
  assert.equal(m3[0].confirmed_by_interview, false);
  assert.equal(stats.new, 1);

  // citeOverlap is a small helper — sanity-check it directly
  assert.equal(
    citeOverlap(["a:1", "b:2"], ["a:9", "c:3"]),
    1
  );
}

{
  // confidence-evolution: skip rate demotes, accept rate promotes
  const { applyStatsToConfidence } = await import(
    "../src/principles/confidence-evolution.mjs"
  );

  const principles = [
    { id: "p-skipped", confidence: "medium" },
    { id: "p-accepted", confidence: "medium" },
    { id: "p-mixed", confidence: "medium" },
    { id: "p-low-data", confidence: "high" }
  ];

  const stats = {
    by_principle: {
      "p-skipped": {
        total_seen: 10,
        accepted: 0,
        edited: 0,
        skipped: 10,
        recent_outcomes: Array(10).fill("skipped")
      },
      "p-accepted": {
        total_seen: 10,
        accepted: 10,
        edited: 0,
        skipped: 0,
        recent_outcomes: Array(10).fill("accepted")
      },
      "p-mixed": {
        total_seen: 10,
        accepted: 4,
        edited: 2,
        skipped: 4,
        recent_outcomes: ["accepted", "skipped", "accepted", "skipped", "edited", "accepted", "skipped", "skipped", "edited", "accepted"]
      },
      "p-low-data": {
        // below MIN_DATAPOINTS — should NOT change despite 100% skip
        total_seen: 2,
        accepted: 0,
        edited: 0,
        skipped: 2,
        recent_outcomes: ["skipped", "skipped"]
      }
    }
  };

  const { principles: evolved, changes } = applyStatsToConfidence(principles, stats);
  const map = new Map(evolved.map((p) => [p.id, p]));
  assert.equal(map.get("p-skipped").confidence, "low");
  assert.equal(map.get("p-accepted").confidence, "high");
  assert.equal(map.get("p-mixed").confidence, "medium"); // no change
  assert.equal(map.get("p-low-data").confidence, "high"); // no change (below min)
  const changeIds = new Set(changes.map((c) => c.principle_id));
  assert.ok(changeIds.has("p-skipped"));
  assert.ok(changeIds.has("p-accepted"));
  assert.ok(!changeIds.has("p-mixed"));
  assert.ok(!changeIds.has("p-low-data"));
}

{
  // suppression: all comment forms + multi-principle + wildcard
  const { parseSuppressionLine, applySuppressions } = await import(
    "../src/review/suppression.mjs"
  );

  // Form coverage
  assert.deepEqual(parseSuppressionLine("// adr-ignore: foo"), ["foo"]);
  assert.deepEqual(parseSuppressionLine("# adr-ignore: foo, bar"), ["foo", "bar"]);
  assert.deepEqual(
    parseSuppressionLine("/* adr-ignore: foo */"),
    ["foo"]
  );
  assert.deepEqual(
    parseSuppressionLine("<!-- adr-ignore: foo -->"),
    ["foo"]
  );
  assert.equal(parseSuppressionLine("// nothing here"), null);

  // applySuppressions end-to-end
  const violations = [
    { principle_id: "p1", file: "src/foo.ts", line: 5, severity: "high", message: "x" },
    { principle_id: "p2", file: "src/foo.ts", line: 7, severity: "medium", message: "y" },
    { principle_id: "p3", file: "src/foo.ts", line: 10, severity: "low", message: "z" }
  ];
  const file = {
    new_path: "src/foo.ts",
    binary: false,
    hunks: [
      {
        new_start: 1,
        new_count: 10,
        section: "",
        lines: [
          { kind: "add", new_line: 4, text: "// adr-ignore: p1" },
          { kind: "add", new_line: 5, text: "violating code 1" },
          { kind: "context", new_line: 7, text: "violating code 2  // adr-ignore: p2" },
          { kind: "context", new_line: 10, text: "violating code 3  // adr-ignore: *" }
        ]
      }
    ]
  };
  const result = applySuppressions(violations, [file]);
  assert.equal(result.kept.length, 0);
  assert.equal(result.suppressed.length, 3);
}

{
  // principle-stats: applyOutcomes + window
  const { applyOutcomes, emptyStats } = await import(
    "../src/review/principle-stats.mjs"
  );
  let stats = emptyStats();
  stats = applyOutcomes(
    stats,
    [
      { principle_id: "p1", outcome: "accepted" },
      { principle_id: "p1", outcome: "skipped" },
      { principle_id: "p1", outcome: "accepted" },
      { principle_id: "p2", outcome: "edited" }
    ],
    "2026-05-25T00:00:00.000Z"
  );
  assert.equal(stats.by_principle.p1.total_seen, 3);
  assert.equal(stats.by_principle.p1.accepted, 2);
  assert.equal(stats.by_principle.p1.skipped, 1);
  assert.equal(stats.by_principle.p2.edited, 1);
  // Window cap: push 30 outcomes, expect only last 20 kept
  const many = Array.from({ length: 30 }, () => ({
    principle_id: "p3",
    outcome: "accepted"
  }));
  stats = applyOutcomes(stats, many, "2026-05-25T00:01:00.000Z");
  assert.equal(stats.by_principle.p3.recent_outcomes.length, 20);
}

{
  // hunk-parser: rename, binary, multi-hunk
  const { parseDiff } = await import("../src/review/hunk-parser.mjs");

  // Rename + content change
  const renamed = parseDiff(
    [
      "diff --git a/old/path.ts b/new/path.ts",
      "similarity index 95%",
      "rename from old/path.ts",
      "rename to new/path.ts",
      "index 1111111..2222222 100644",
      "--- a/old/path.ts",
      "+++ b/new/path.ts",
      "@@ -1,3 +1,3 @@",
      " context",
      "-old line",
      "+new line",
      " more context",
      ""
    ].join("\n")
  );
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].new_path, "new/path.ts");
  assert.equal(renamed[0].old_path, "old/path.ts");

  // Binary
  const binary = parseDiff(
    [
      "diff --git a/foo.png b/foo.png",
      "Binary files a/foo.png and b/foo.png differ",
      ""
    ].join("\n")
  );
  assert.equal(binary.length, 1);
  assert.equal(binary[0].binary, true);
  assert.equal(binary[0].hunks.length, 0);

  // Multi-hunk
  const multi = parseDiff(
    [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
      "@@ -10,3 +10,3 @@",
      " d",
      "-e",
      "+E",
      " f",
      ""
    ].join("\n")
  );
  assert.equal(multi[0].hunks.length, 2);
  assert.equal(multi[0].hunks[0].new_start, 1);
  assert.equal(multi[0].hunks[1].new_start, 10);
}

{
  // cite-verifier: computeHealthSnapshot
  const { computeHealthSnapshot } = await import(
    "../src/principles/cite-verifier.mjs"
  );
  const verifyRepoDir = await mkdtemp(
    path.join(os.tmpdir(), "adr-cite-verifier-")
  );
  await mkdir(path.join(verifyRepoDir, "src"), { recursive: true });
  await writeFile(path.join(verifyRepoDir, "src", "real.ts"), "// real");

  const artifact = {
    principles: [
      {
        id: "p-fresh",
        evidence_cite: ["src/real.ts:1", "src/real.ts:5"]
      },
      {
        id: "p-stale",
        evidence_cite: ["src/ghost.ts:1", "src/real.ts:1"]
      },
      {
        id: "p-rotten",
        evidence_cite: ["src/ghost.ts:1", "src/missing.ts:1"]
      }
    ]
  };
  const health = await computeHealthSnapshot(artifact, verifyRepoDir);
  assert.equal(health.total_principles, 3);
  assert.equal(health.total_citations, 6);
  assert.equal(health.stale_citation_count, 3);
  // p-fresh: 0/2 = 0% → not stale
  // p-stale: 1/2 = 50% → stale
  // p-rotten: 2/2 = 100% → stale
  assert.equal(health.stale_principle_count, 2);

  await rm(verifyRepoDir, { recursive: true, force: true });
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
      ...knowledgeMap.candidates.map((c) => c.name),
      ...knowledgeMap.off_topic_candidates.map((c) => c.name)
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
// Clarification gate: PRD "Open questions" are folded into clarification,
// but the gate is NON-BLOCKING. Detection still fires; the run continues.
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

  // prepareRun: gate is non-blocking. Even with a thin PRD, the run
  // continues; the gaps are surfaced as decision_context_gaps_detected.
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "adr-clarify-test-"));
  const thinPrdPath = path.join(tmpDir, "thin.md");
  await writeFile(
    thinPrdPath,
    "# Product Context\n\n## Decision\n\nPick something.\n\n## Open questions\n\n- What latency?\n- What scale?\n"
  );

  installProvider((label) => {
    if (label === "strategic_context_extractor") {
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
    }
    if (label === "decision_context_extractor") {
      return { notes: [] };
    }
    throw new Error(`prepareRun fixture: unexpected label ${label}`);
  });

  // Non-blocking: prepareRun returns with needsClarification=false even
  // when the PRD is thin. The clarification questions remain on the
  // returned object so callers can surface them; they no longer halt.
  const result = await prepareRun({
    inputPath: thinPrdPath,
    flags: {
      domain: "saas",
      decision: "auth provider",
      out: path.join(tmpDir, "out-thin")
    }
  });
  assert.equal(result.needsClarification, false, "thin PRD no longer halts the run");
  assert.ok(result.clarification.questions.length > 0, "gaps still detected");
  assert.ok(
    result.clarification.questions.some((q) => q.startsWith("From PRD Open questions:")),
    "PRD Open questions should still surface in the clarification record"
  );

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
    context: { domain: "saas", decision: "auth provider" },
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
// Research-report mode:
//
// ADR produces a research report covering every candidate from the knowledge
// map. There is no winner, no recommendation, no mode enum. Every candidate
// gets its own options[] entry. Guardrails are generated lazily via
// `adr handoff --option <name>` — not by writeRunArtifacts.
// ---------------------------------------------------------------------------

{
  // Sub-test 1: the synthesizer must produce an entry for EVERY candidate
  // in knowledge_map.candidates. Hallucinated candidates are dropped.

  installProvider((label) => {
    assert.equal(label, "research_report_agent");
    return {
      id: "ADR-Auth",
      title: "Auth provider",
      executive_summary: "Two candidates surfaced in the auth provider space.",
      option_space_shape: "Managed SaaS dominates the space.",
      options: [
        {
          name: "clerk",
          label: "Clerk",
          summary: "Drop-in auth for Next.js apps.",
          evidence_depth: "thick",
          what_evidence_shows: "Multiple docs describe Clerk's Next.js SDK.",
          what_evidence_does_not_show: "No production-scale cost benchmarks.",
          when_to_pick: ["You want low integration time"],
          when_not_to_pick: ["You require on-prem deployment"],
          strong_axes: ["pricing_model", "sdk_integration_quality"],
          weak_axes: ["on_prem_self_host"],
          citations: [1, 2]
        },
        {
          name: "auth0",
          label: "Auth0",
          summary: "Mature OAuth-first provider.",
          evidence_depth: "medium",
          what_evidence_shows: "Documented SSO/SAML and tenant isolation patterns.",
          what_evidence_does_not_show: "No fresh community discussion on pricing.",
          when_to_pick: ["You need enterprise SSO/SAML"],
          when_not_to_pick: ["You are price-sensitive at scale"],
          strong_axes: ["sdk_integration_quality"],
          weak_axes: ["pricing_model"],
          citations: [3]
        }
      ],
      cross_cutting_tradeoffs: [
        {
          axis: "pricing_model",
          observation: "Clerk wins on pricing; Auth0 weak.",
          candidates_high: ["clerk"],
          candidates_low: ["auth0"]
        }
      ],
      open_questions: ["What does Clerk look like at >1M MAU?"],
      domain_model: {
        bounded_contexts: ["AuthContext"],
        core_entities: ["User"],
        domain_invariants: []
      },
      evidence_summary: { allowed_agentic_use: ["onboarding"] }
    };
  });

  const km = {
    acquisition_rule: "test rule",
    candidates: [
      { name: "clerk", label: "Clerk", evidence_depth: "thick", citations: [1, 2], evidence_count: 5 },
      { name: "auth0", label: "Auth0", evidence_depth: "medium", citations: [3], evidence_count: 3 }
    ],
    off_topic_candidates: []
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

  // Every candidate must have an options entry — the report does not
  // filter or pick a winner.
  assert.equal(spec.options.length, 2, "every candidate gets a section");
  const byName = Object.fromEntries(spec.options.map((o) => [o.name, o]));
  assert.equal(byName.clerk.evidence_depth, "thick");
  assert.equal(byName.auth0.evidence_depth, "medium");
  assert.equal(spec.executive_summary.length > 0, true);
  assert.equal(spec.options[0].what_evidence_shows.length > 0, true);

  // buildGuardrails scoped to one option produces only that option's block.
  const guardrailsMd = buildGuardrails(spec, { targetOptionName: "clerk" });
  assert.ok(guardrailsMd.includes("Option: `clerk`"));
  assert.ok(!guardrailsMd.includes("Option: `auth0`"), "scoped guardrails only renders chosen option");
  assert.ok(guardrailsMd.includes("**Evidence depth:** thick"));

  // Unscoped guardrails (no chosen option) renders all candidates.
  const fullGuardrails = buildGuardrails(spec);
  assert.ok(fullGuardrails.includes("Option: `clerk`"));
  assert.ok(fullGuardrails.includes("Option: `auth0`"));
  assert.ok(fullGuardrails.includes("No option chosen"));

  setLlmJsonProvider(null);
}

{
  // Sub-test 2: candidate-backstop. When the synthesizer DROPS a candidate
  // (the prompt forbids this), the kernel inserts a minimal entry so
  // nothing silently disappears from the report.
  installProvider((label) => {
    assert.equal(label, "research_report_agent");
    return {
      id: "ADR-Retrieval",
      title: "Retrieval Topology",
      executive_summary: "GraphRAG only; synthesizer skipped vector_rag.",
      option_space_shape: "Two retrieval styles.",
      // Only ONE option emitted — vector_rag is missing.
      options: [
        {
          name: "graphrag",
          label: "GraphRAG",
          summary: "Graph-based retrieval.",
          evidence_depth: "medium",
          what_evidence_shows: "Multi-hop benchmarks.",
          what_evidence_does_not_show: "No production cost data.",
          when_to_pick: ["Multi-hop"],
          when_not_to_pick: ["Single-hop only"],
          strong_axes: ["multi_hop_relational"],
          weak_axes: ["index_build_cost"],
          citations: [1]
        }
      ],
      cross_cutting_tradeoffs: [],
      open_questions: [],
      domain_model: {},
      evidence_summary: {}
    };
  });

  const km2 = {
    acquisition_rule: "test",
    candidates: [
      { name: "graphrag", label: "GraphRAG", evidence_depth: "medium", citations: [1], evidence_count: 3 },
      { name: "vector_rag", label: "Vector RAG", evidence_depth: "thin", citations: [2], evidence_count: 1 }
    ],
    off_topic_candidates: []
  };
  const evidence2 = [
    { citation_id: 1, title: "graphrag paper", url: "https://...", source_type: "paper_or_benchmark", score: 0.9, excerpt: "...", claims: [], relevance: "x" },
    { citation_id: 2, title: "vectorrag", url: "https://...", source_type: "official_docs", score: 0.8, excerpt: "...", claims: [], relevance: "x" }
  ];

  const spec = await synthesizeDecisionPhase({
    context: {
      domain: "kb",
      decision: "retrieval topology",
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

  // Backstop: both candidates must appear, even though the synthesizer
  // only emitted one.
  assert.equal(spec.options.length, 2, "backstop must fill in missing candidate");
  const byName = Object.fromEntries(spec.options.map((o) => [o.name, o]));
  assert.equal(byName.graphrag.summary, "Graph-based retrieval.");
  assert.equal(byName.vector_rag.evidence_depth, "thin");
  assert.ok(byName.vector_rag.what_evidence_shows.includes("did not produce a section"));

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

// ---------------------------------------------------------------------------
// Bidirectional private_corpus claims: when a discovered pattern lists
// opposes_families, the discover stage emits ONE supporting item for its own
// architecture_family AND one opposing item per opposes_families entry, each
// with polarity: "rejects" and that family as architecture_family. This is
// what lets "team uses pgvector" count as opposing evidence against pinecone
// in the matrix, not just supporting evidence for pgvector.
// ---------------------------------------------------------------------------

{
  const { discoveredEvidenceItems } = await import("../src/discover/discovered-evidence.mjs");

  const items = discoveredEvidenceItems({
    patterns: [
      {
        name: "shared_postgres_with_pgvector",
        description: "Team stores embeddings in pgvector inside the existing Postgres.",
        evidence_cite: ["packages/core/src/storage.ts", "ARCHITECTURE.md"],
        architecture_family: "pgvector",
        opposes_families: ["pinecone", "weaviate", "external_vector_db"]
      },
      {
        name: "no_architecture_family_pattern",
        description: "internal layout",
        evidence_cite: ["foo.ts"]
        // no architecture_family -> skipped entirely
      }
    ],
    antipatterns: [
      {
        name: "deprecated_kafka_event_bus",
        reason: "Team migrated off Kafka; ARCHITECTURE.md lists it as rejected.",
        evidence_cite: ["docs/adr/0003.md"],
        architecture_family: "kafka_event_bus",
        opposes_families: ["service_mesh_with_kafka_dlq"]
      }
    ]
  });

  // Expected items:
  //  - 1 supporting "pgvector" from the pattern
  //  - 3 opposing items: pinecone, weaviate, external_vector_db
  //  - 1 rejecting "kafka_event_bus" from the antipattern
  //  - 1 opposing item: service_mesh_with_kafka_dlq
  // = 6 total. The pattern with no architecture_family is dropped.
  assert.equal(items.length, 6, `expected 6 items, got: ${items.map((i) => i.title).join(" | ")}`);

  const byFamilyAndPolarity = items.map((item) => ({
    family: item.claims[0].architecture_family,
    polarity: item.claims[0].polarity
  }));

  // Pattern's own family supported:
  assert.ok(
    byFamilyAndPolarity.some((x) => x.family === "pgvector" && x.polarity === "supports"),
    `expected supporting pgvector claim, got ${JSON.stringify(byFamilyAndPolarity)}`
  );
  // Opposed families each get a rejecting claim:
  for (const opposed of ["pinecone", "weaviate", "external_vector_db"]) {
    assert.ok(
      byFamilyAndPolarity.some((x) => x.family === opposed && x.polarity === "rejects"),
      `expected rejecting ${opposed} claim, got ${JSON.stringify(byFamilyAndPolarity)}`
    );
  }
  // Antipattern's own family rejected:
  assert.ok(
    byFamilyAndPolarity.some((x) => x.family === "kafka_event_bus" && x.polarity === "rejects")
  );
  // Antipattern's additional opposed family rejected:
  assert.ok(
    byFamilyAndPolarity.some((x) => x.family === "service_mesh_with_kafka_dlq" && x.polarity === "rejects")
  );

  // Empty opposes_families is a no-op (no extra items, just the support claim):
  const noOpposes = discoveredEvidenceItems({
    patterns: [
      {
        name: "plain",
        description: "no opposes",
        evidence_cite: ["x.ts"],
        architecture_family: "plain"
      }
    ],
    antipatterns: []
  });
  assert.equal(noOpposes.length, 1);
  assert.equal(noOpposes[0].claims[0].polarity, "supports");

  // De-dup within a single pattern: same family listed twice in opposes_families
  // only generates one opposing item.
  const dedup = discoveredEvidenceItems({
    patterns: [
      {
        name: "x",
        evidence_cite: ["a.ts"],
        architecture_family: "x_fam",
        opposes_families: ["pinecone", "pinecone", "weaviate"]
      }
    ],
    antipatterns: []
  });
  assert.equal(dedup.length, 3); // 1 supporting + 2 unique opposing
}

// ---------------------------------------------------------------------------
// Source-snapshot cache: openUrl should cache successful fetches to
// ADR_CACHE_DIR and skip the network on a second call within the TTL.
// Empty/non-OK responses MUST NOT be cached so transient failures retry.
// ---------------------------------------------------------------------------

{
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "adr-cache-test-"));
  const priorCacheDir = process.env.ADR_CACHE_DIR;
  const priorDisable = process.env.ADR_CACHE_DISABLE;
  process.env.ADR_CACHE_DIR = cacheDir;
  delete process.env.ADR_CACHE_DISABLE;

  let fetchCount = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("<html><body><p>Hello world cached.</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  };

  try {
    const url = "https://example.com/test-page";
    const first = await openUrl(url, {});
    assert.ok(first.length > 0, "first openUrl call should return content");
    assert.equal(fetchCount, 1, "first call should hit network");

    const second = await openUrl(url, {});
    assert.equal(second, first, "cached result should match first");
    assert.equal(fetchCount, 1, "second call should NOT hit network");

    // Fragment-stripped: same URL with #section should still hit cache.
    const third = await openUrl(`${url}#section`, {});
    assert.equal(third, first, "fragment-stripped URL should hit cache");
    assert.equal(fetchCount, 1, "fragment call should NOT hit network");

    // Disabling the cache makes the next call hit network again.
    process.env.ADR_CACHE_DISABLE = "1";
    const fourth = await openUrl(url, {});
    assert.ok(fourth.length > 0);
    assert.equal(fetchCount, 2, "ADR_CACHE_DISABLE=1 must bypass cache");
  } finally {
    globalThis.fetch = realFetch;
    await rm(cacheDir, { recursive: true, force: true });
    if (priorCacheDir === undefined) delete process.env.ADR_CACHE_DIR;
    else process.env.ADR_CACHE_DIR = priorCacheDir;
    if (priorDisable === undefined) delete process.env.ADR_CACHE_DISABLE;
    else process.env.ADR_CACHE_DISABLE = priorDisable;
  }
}

{
  // Negative result (non-OK fetch) must not be cached.
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "adr-cache-neg-test-"));
  const priorCacheDir = process.env.ADR_CACHE_DIR;
  process.env.ADR_CACHE_DIR = cacheDir;
  delete process.env.ADR_CACHE_DISABLE;

  let fetchCount = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount += 1;
    // First call returns 500, second returns 200.
    if (fetchCount === 1) {
      return new Response("server error", { status: 500 });
    }
    return new Response("<html><body><p>OK now.</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  };

  try {
    const url = "https://example.com/flaky";
    const first = await openUrl(url, {});
    assert.equal(first, "", "non-OK should return empty");
    const second = await openUrl(url, {});
    assert.equal(fetchCount, 2, "transient failure should not be cached — retry");
    assert.ok(second.length > 0);
  } finally {
    globalThis.fetch = realFetch;
    await rm(cacheDir, { recursive: true, force: true });
    if (priorCacheDir === undefined) delete process.env.ADR_CACHE_DIR;
    else process.env.ADR_CACHE_DIR = priorCacheDir;
  }
}

// ---------------------------------------------------------------------------
// Decision-relevance filter: drops candidates that cleared the evidence gate
// but are not plausible answers to the decision (the discover-phase
// contamination case — nextjs/postgres end up in the auth-provider pool).
// ---------------------------------------------------------------------------

{
  const tmpOutDir = await mkdtemp(path.join(os.tmpdir(), "adr-relevance-test-"));

  installProvider((label) => {
    assert.equal(label, "candidate_relevance_filter");
    return {
      verdicts: [
        { name: "clerk", verdict: "relevant", reason: "Named auth provider." },
        { name: "auth0", verdict: "relevant", reason: "Named auth provider." },
        { name: "nextjs", verdict: "off_topic", reason: "Framework, not an auth provider." },
        { name: "postgres_centric_storage", verdict: "off_topic", reason: "Storage choice, not auth." },
        { name: "supertokens", verdict: "unsure", reason: "Possibly relevant." }
      ]
    };
  });

  const knowledgeMap = {
    acquisition_rule: "test",
    candidates: [
      { name: "clerk", label: "Clerk", evidence_depth: "medium", evidence_count: 3, source_types: ["official_docs"], support: [], citations: [1], score: 1.2 },
      { name: "auth0", label: "Auth0", evidence_depth: "medium", evidence_count: 2, source_types: ["official_docs"], support: [], citations: [2], score: 0.9 },
      { name: "nextjs", label: "Next.js", evidence_depth: "medium", evidence_count: 2, source_types: ["private_corpus"], support: [], citations: [3], score: 0.6 },
      { name: "postgres_centric_storage", label: "Postgres", evidence_depth: "medium", evidence_count: 2, source_types: ["private_corpus"], support: [], citations: [4], score: 0.6 },
      { name: "supertokens", label: "SuperTokens", evidence_depth: "medium", evidence_count: 2, source_types: ["mature_oss"], support: [], citations: [5], score: 0.8 }
    ],
    off_topic_candidates: []
  };

  const result = await filterPromotedByRelevance({
    context: { decision: "auth provider", domain: "saas" },
    knowledgeMap,
    outDir: tmpOutDir,
    flags: {}
  });

  // off_topic candidates dropped. unsure + relevant survive.
  assert.equal(result.dropped.length, 2, `expected 2 dropped, got: ${JSON.stringify(result.dropped)}`);
  const droppedNames = result.dropped.map((d) => d.name).sort();
  assert.deepEqual(droppedNames, ["nextjs", "postgres_centric_storage"]);
  const keptNames = result.knowledgeMap.candidates.map((c) => c.name).sort();
  assert.deepEqual(keptNames, ["auth0", "clerk", "supertokens"]);
  // Dropped candidates moved into off_topic_candidates with the
  // off_topic_for_decision marker.
  const moved = result.knowledgeMap.off_topic_candidates.filter(
    (c) => c.off_topic_for_decision === true
  );
  assert.equal(moved.length, 2);
  assert.ok(moved.some((c) => c.off_topic_reason.includes("Framework")));

  setLlmJsonProvider(null);

  // --skip-relevance-filter passes the knowledge map through unchanged.
  const skipResult = await filterPromotedByRelevance({
    context: { decision: "auth provider", domain: "saas" },
    knowledgeMap,
    outDir: tmpOutDir,
    flags: { "skip-relevance-filter": true }
  });
  assert.equal(skipResult.skipped, true);
  assert.equal(skipResult.knowledgeMap, knowledgeMap);

  await rm(tmpOutDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Schema-validation guard: the spec the synthesizer returns MUST pass the
// JSON schema for research-report.json. Catching this in tests prevents
// "ran the whole pipeline, then died at the last writeJson" failures.
// ---------------------------------------------------------------------------

{
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "adr-schema-validate-test-"));

  installProvider((label) => {
    assert.equal(label, "research_report_agent");
    return {
      id: "ADR-Vector",
      title: "Vector store",
      executive_summary: "Two candidates surfaced in the vector-store space.",
      option_space_shape: "OSS extensions vs managed SaaS.",
      options: [
        { name: "pgvector", label: "pgvector", summary: "x", evidence_depth: "medium", what_evidence_shows: "a", what_evidence_does_not_show: "b", citations: [1] },
        { name: "pinecone", label: "Pinecone", summary: "y", evidence_depth: "medium", what_evidence_shows: "a", what_evidence_does_not_show: "b", citations: [2] }
      ],
      cross_cutting_tradeoffs: [],
      open_questions: [],
      domain_model: { bounded_contexts: [], core_entities: [], domain_invariants: [] },
      evidence_summary: {}
    };
  });

  const km = {
    acquisition_rule: "test",
    candidates: [
      { name: "pgvector", label: "pgvector", evidence_depth: "medium", citations: [1], evidence_count: 2 },
      { name: "pinecone", label: "Pinecone", evidence_depth: "medium", citations: [2], evidence_count: 2 }
    ],
    off_topic_candidates: []
  };
  const ev = [
    { citation_id: 1, title: "pgvector", url: "https://example.com/1", source_type: "official_docs", score: 0.9, excerpt: "x", claims: [], relevance: "x" },
    { citation_id: 2, title: "Pinecone", url: "https://example.com/2", source_type: "official_docs", score: 0.8, excerpt: "y", claims: [], relevance: "x" }
  ];

  const spec = await synthesizeDecisionPhase({
    context: {
      domain: "saas",
      decision: "vector store",
      domain_entities: [],
      bounded_contexts: [],
      query_shapes: [],
      operational_envelope: { latency: "x", cost: "x", scale: "x", availability: "x" },
      compliance_constraints: [],
      risk_invariants: []
    },
    knowledgeMap: km,
    evidenceItems: ev,
    comparisonMatrix: null
  });

  // writeJson validates against the research-report.schema.json; this guards
  // against "spec drifted from schema" pathologies catching them at test time.
  const specPath = path.join(tmpDir, "research-report.json");
  await writeJson(specPath, spec);
  const written = JSON.parse(await readFile(specPath, "utf8"));
  assert.equal(written.options.length, 2);
  assert.equal(written.options[0].name, "pgvector");
  assert.equal(written.options[1].name, "pinecone");

  setLlmJsonProvider(null);
  await rm(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Adversarial round-robin: every promoted candidate must get exactly one
// adversarial probe. When the LLM skips candidates, the kernel pads with
// fallback probes so no candidate looks artificially clean by absence.
// ---------------------------------------------------------------------------

{
  installProvider((label) => {
    assert.equal(label, "adversarial_research_planner");
    // Simulate a buggy LLM that only generates probes for 2 of 5 candidates,
    // disproportionately focused on pgvector. The balancer must compensate.
    return {
      tasks: [
        {
          id: "X1",
          title: "pgvector failure modes",
          objective: "Find pgvector limitations.",
          search_queries: ["pgvector limitations"],
          target_candidate: "pgvector"
        },
        {
          id: "X2",
          title: "pgvector p95 latency cases",
          objective: "Find pgvector latency issues.",
          search_queries: ["pgvector slow"],
          target_candidate: "pgvector"
        },
        {
          id: "X3",
          title: "weaviate scaling limits",
          objective: "Find weaviate scaling issues.",
          search_queries: ["weaviate scaling"],
          target_candidate: "weaviate"
        }
        // milvus, pinecone, faiss — completely missing from LLM output
      ]
    };
  });

  const matrix = {
    candidates: [
      { name: "pgvector", label: "pgvector", evidence_depth: "medium" },
      { name: "weaviate", label: "Weaviate", evidence_depth: "medium" },
      { name: "milvus", label: "Milvus", evidence_depth: "medium" },
      { name: "pinecone", label: "Pinecone", evidence_depth: "medium" },
      { name: "faiss", label: "Faiss", evidence_depth: "medium" }
    ],
    axes: [],
    empty_cells: []
  };

  const plan = await buildAdversarialResearchPlan({
    context: { domain: "saas", decision: "vector store" },
    matrix,
    evidenceItems: []
  });

  // Every promoted candidate must get exactly 1 task — no exceptions.
  assert.equal(plan.tasks.length, 5, `expected 5 balanced tasks, got: ${plan.tasks.map((t) => t.target_candidate).join(", ")}`);
  const counts = plan.tasks.reduce((m, t) => {
    m[t.target_candidate] = (m[t.target_candidate] || 0) + 1;
    return m;
  }, {});
  for (const candidate of ["pgvector", "weaviate", "milvus", "pinecone", "faiss"]) {
    assert.equal(counts[candidate], 1, `${candidate} should get exactly 1 probe, got ${counts[candidate]}`);
  }
  // Three candidates were padded (milvus, pinecone, faiss).
  assert.equal(plan.balancing.padded_for_skipped_candidates, 3);
  assert.equal(plan.balancing.llm_emitted, 3);

  setLlmJsonProvider(null);
}

// ---------------------------------------------------------------------------
// Peer products feature:
//
//   discover --include-peers writes peers.json with 3-5 named similar
//   products. When deep-research later runs against the same out_dir, the
//   planner picks up peers.json and adds one targeted research task per
//   peer for the specific decision aspect.
//
// This test covers: peer-finder LLM call returns peers, GitHub fetch is
// stubbed/skipped, planResearchPhase reads peers.json and emits peer tasks.
// ---------------------------------------------------------------------------

{
  const { findPeers } = await import("../src/discover/peer-finder.mjs");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "adr-peers-test-"));

  // Stub global fetch so GitHub signal calls return predictable data and
  // don't actually hit the network.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/repos/cal-com/cal.com")) {
      return new Response(JSON.stringify({
        stargazers_count: 33000,
        open_issues_count: 600,
        language: "TypeScript",
        pushed_at: "2026-05-01T00:00:00Z",
        created_at: "2021-06-15T00:00:00Z"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/repos/onyx-dot-app/onyx")) {
      return new Response(JSON.stringify({
        stargazers_count: 12000,
        open_issues_count: 250,
        language: "Python",
        pushed_at: "2026-05-10T00:00:00Z",
        created_at: "2023-01-01T00:00:00Z"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/repos/abandoned/dead-repo")) {
      return new Response(JSON.stringify({
        stargazers_count: 800,
        open_issues_count: 0,
        language: "Go",
        pushed_at: "2022-01-01T00:00:00Z", // > 18 months stale
        created_at: "2020-01-01T00:00:00Z"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    installProvider((label) => {
      assert.equal(label, "discover_peer_finder");
      return {
        peers: [
          {
            name: "cal-com",
            label: "Cal.com",
            github_url: "https://github.com/cal-com/cal.com",
            docs_url: "https://cal.com/docs",
            engineering_blog_url: "https://cal.com/blog",
            why_comparable: "Multi-tenant SaaS shipping its own auth + scheduling.",
            evidence_strategy: "architecture"
          },
          {
            name: "onyx",
            label: "Onyx",
            github_url: "https://github.com/onyx-dot-app/onyx",
            docs_url: "https://docs.onyx.app",
            engineering_blog_url: "",
            why_comparable: "Self-hosted agent runtime with similar agent OS shape.",
            evidence_strategy: "both"
          },
          {
            name: "abandoned",
            label: "Abandoned Tool",
            github_url: "https://github.com/abandoned/dead-repo",
            why_comparable: "Was comparable; appears no longer maintained."
            // no evidence_strategy → defaults to "architecture"
          },
          {
            name: "notion",
            label: "Notion",
            github_url: "",
            homepage_url: "https://notion.so",
            why_comparable: "Closed-source SaaS at similar abstraction layer.",
            evidence_strategy: "adoption"
          },
          {
            name: "bogus-strategy",
            label: "Bogus Strategy Peer",
            github_url: "",
            homepage_url: "https://example.invalid",
            why_comparable: "Verifies that an unknown evidence_strategy value defaults to architecture.",
            evidence_strategy: "made_up_value"
          }
        ]
      };
    });

    const artifact = await findPeers({
      decision: "vector store for agent memory",
      domain: "agent-native OS",
      decisionKind: "concrete",
      seed: "beevibe",
      prd: "self-hosted multi-tenant agent OS for companies, runs in Docker Compose, Postgres-backed",
      repoDigest: null,
      flags: {},
      maxPeers: 5
    });

    // Stale repo (>18 months no commits) must be dropped:
    const names = artifact.peers.map((p) => p.name).sort();
    assert.ok(!names.includes("abandoned"), `stale repo should be dropped; got: ${names.join(", ")}`);

    // Closed-source peer (no github_url) must survive:
    assert.ok(names.includes("notion"), "closed-source peer (Notion) must survive");

    // GitHub signal must be populated on open-source peers with successful fetch:
    const calCom = artifact.peers.find((p) => p.name === "cal-com");
    assert.ok(calCom, "cal-com should be in the result");
    assert.equal(calCom.signal?.stars, 33000);
    assert.equal(calCom.signal?.primary_language, "TypeScript");

    // Ranking: cal-com (33k stars, recent) should outrank onyx (12k stars).
    const calIdx = artifact.peers.findIndex((p) => p.name === "cal-com");
    const onyxIdx = artifact.peers.findIndex((p) => p.name === "onyx");
    assert.ok(calIdx < onyxIdx, `cal-com should rank above onyx; got order ${artifact.peers.map((p) => p.name).join(", ")}`);

    // evidence_strategy lands on each peer. Unknown / missing values default
    // to "architecture" — they must never strand the peer in an undefined
    // strategy state.
    const byName = Object.fromEntries(artifact.peers.map((p) => [p.name, p]));
    if (byName["cal-com"]) assert.equal(byName["cal-com"].evidence_strategy, "architecture");
    if (byName.onyx) assert.equal(byName.onyx.evidence_strategy, "both");
    if (byName.notion) assert.equal(byName.notion.evidence_strategy, "adoption");
    if (byName["bogus-strategy"]) {
      assert.equal(
        byName["bogus-strategy"].evidence_strategy,
        "architecture",
        "unknown evidence_strategy must default to architecture"
      );
    }

    setLlmJsonProvider(null);
  } finally {
    globalThis.fetch = realFetch;
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Adoption-strategy peers: when a peer's evidence_strategy is "adoption" or
// "both", buildPeerResearchTasks calls the adoption_research_planner LLM
// label to generate community-targeted queries (Reddit, HN, Twitter,
// migration write-ups) instead of architecture-targeted ones. Architecture-
// strategy peers keep today's behavior and skip the LLM call entirely.
// ---------------------------------------------------------------------------

{
  const { buildPeerResearchTasks } = await import("../src/kernel.mjs");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "adr-peer-strategy-test-"));

  try {
    await writeJson(path.join(tmpDir, "peers.json"), {
      version: "0.2.0",
      decision: "knowledge store",
      domain: "PKM",
      peers: [
        {
          name: "neo4j",
          label: "Neo4j",
          github_url: "https://github.com/neo4j/neo4j",
          docs_url: "https://neo4j.com/docs",
          engineering_blog_url: "https://neo4j.com/blog",
          why_comparable: "Mature graph DB peer.",
          evidence_strategy: "architecture"
        },
        {
          name: "obsidian",
          label: "Obsidian",
          github_url: "",
          homepage_url: "https://obsidian.md",
          why_comparable: "Closed-source PKM with huge adoption signal.",
          evidence_strategy: "adoption"
        },
        {
          name: "logseq",
          label: "Logseq",
          github_url: "https://github.com/logseq/logseq",
          why_comparable: "Open-core PKM with both architecture docs and adoption community.",
          evidence_strategy: "both"
        }
      ]
    });

    let adoptionCalls = 0;
    installProvider((label) => {
      if (label === "adoption_research_planner") {
        adoptionCalls += 1;
        return {
          queries: [
            "fixture: peer reddit users architecture experience knowledge store",
            "fixture: peer hacker news comments knowledge store",
            "fixture: site:reddit.com peer pkm"
          ]
        };
      }
      throw new Error(`unexpected label ${label}`);
    });

    const result = await buildPeerResearchTasks({
      context: { decision: "knowledge store", domain: "PKM" },
      outDir: tmpDir
    });
    assert.equal(result.status, "ok");
    assert.equal(result.tasks.length, 3);

    const tasksByPeer = Object.fromEntries(result.tasks.map((t) => [t.peer_target, t]));
    // Architecture peer keeps today's behavior — no LLM call, queries hit
    // github + blog.
    const neoQs = tasksByPeer.neo4j.search_queries.join(" | ");
    assert.ok(neoQs.includes("site:github.com"), `neo4j should keep architecture queries: ${neoQs}`);
    assert.ok(!neoQs.includes("fixture:"), "architecture peer must not call adoption planner");
    assert.equal(tasksByPeer.neo4j.evidence_strategy, "architecture");

    // Adoption peer routes to the LLM planner — queries come from the fixture.
    const obsQs = tasksByPeer.obsidian.search_queries.join(" | ");
    assert.ok(obsQs.includes("fixture:"), `obsidian must use adoption queries: ${obsQs}`);
    assert.equal(tasksByPeer.obsidian.evidence_strategy, "adoption");
    assert.ok(
      tasksByPeer.obsidian.title.toLowerCase().includes("adoption"),
      "adoption peer's task title should reflect adoption framing"
    );

    // "both" peer gets architecture queries first, then adoption queries,
    // capped at PEER_TASK_MAX_QUERIES (5).
    const logseqQs = tasksByPeer.logseq.search_queries;
    assert.ok(logseqQs.length <= 5, `both-strategy peer capped at 5 queries; got ${logseqQs.length}`);
    assert.ok(
      logseqQs.some((q) => q.includes("site:github.com")),
      "both-strategy peer must include architecture queries"
    );
    assert.ok(
      logseqQs.some((q) => q.includes("fixture:")),
      "both-strategy peer must include adoption queries"
    );
    assert.equal(tasksByPeer.logseq.evidence_strategy, "both");

    // The adoption planner fired exactly twice — once for adoption, once for
    // both. The architecture peer must not have invoked it.
    assert.equal(adoptionCalls, 2, `expected 2 adoption_research_planner calls, got ${adoptionCalls}`);

    setLlmJsonProvider(null);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// classifySource: community_discussion class with platform tagging.
//   reddit.com/r/<sub> → community_discussion + platform: "reddit"
//   news.ycombinator.com/item?id=N → community_discussion + platform: "hackernews"
//   twitter.com / x.com → community_discussion + platform: "twitter"
//   stackoverflow.com / stackexchange.com → community_discussion + platform: "stackexchange"
// ---------------------------------------------------------------------------

{
  const { classifyCommunityPlatform, extractCommunityPlatformDetails } = await import(
    "../src/kernel.mjs"
  );

  assert.equal(
    classifySource("https://www.reddit.com/r/LocalLLaMA/comments/abc/"),
    "community_discussion"
  );
  assert.equal(
    classifyCommunityPlatform("https://www.reddit.com/r/LocalLLaMA/comments/abc/"),
    "reddit"
  );
  assert.equal(
    extractCommunityPlatformDetails("https://www.reddit.com/r/LocalLLaMA/comments/abc/", "reddit")
      .subreddit,
    "LocalLLaMA"
  );

  assert.equal(
    classifySource("https://news.ycombinator.com/item?id=12345"),
    "community_discussion"
  );
  assert.equal(
    classifyCommunityPlatform("https://news.ycombinator.com/item?id=12345"),
    "hackernews"
  );
  assert.equal(
    extractCommunityPlatformDetails(
      "https://news.ycombinator.com/item?id=12345",
      "hackernews"
    ).story_id,
    "12345"
  );

  assert.equal(classifySource("https://twitter.com/foo/status/1"), "community_discussion");
  assert.equal(classifySource("https://x.com/foo/status/1"), "community_discussion");
  assert.equal(classifyCommunityPlatform("https://twitter.com/foo/status/1"), "twitter");
  assert.equal(classifyCommunityPlatform("https://x.com/foo/status/1"), "twitter");

  assert.equal(
    classifySource("https://stackoverflow.com/questions/12345"),
    "community_discussion"
  );
  assert.equal(
    classifySource("https://serverfault.stackexchange.com/questions/1"),
    "community_discussion"
  );
  assert.equal(
    classifyCommunityPlatform("https://stackoverflow.com/questions/12345"),
    "stackexchange"
  );

  // Non-community URLs unaffected:
  assert.equal(classifySource("https://github.com/foo/bar"), "mature_oss");
  assert.equal(classifySource("https://docs.example.com/"), "official_docs");
}

// ---------------------------------------------------------------------------
// Adoption axes are only added to the comparison matrix when the evidence
// pool contains at least one community_discussion source. Architecture-only
// runs do not get polluted with empty ecosystem_traction / integration_breadth
// / practitioner_pain_points columns.
// ---------------------------------------------------------------------------

{
  const baseContext = {
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

  // No community evidence → adoption axes are NOT added.
  const axesPure = deriveComparisonAxes(baseContext, {
    evidenceItems: [
      { source_type: "official_docs" },
      { source_type: "mature_oss" }
    ]
  });
  const pureIds = axesPure.map((a) => a.id);
  assert.ok(
    !pureIds.includes("ecosystem_traction"),
    `pure architecture run must not add ecosystem_traction; got: ${pureIds.join(", ")}`
  );
  assert.ok(!pureIds.includes("integration_breadth"));
  assert.ok(!pureIds.includes("practitioner_pain_points"));

  // At least one community_discussion source → adoption axes ARE added.
  const axesAdopt = deriveComparisonAxes(baseContext, {
    evidenceItems: [
      { source_type: "official_docs" },
      { source_type: "community_discussion" }
    ]
  });
  const adoptIds = axesAdopt.map((a) => a.id);
  assert.ok(adoptIds.includes("ecosystem_traction"));
  assert.ok(adoptIds.includes("integration_breadth"));
  assert.ok(adoptIds.includes("practitioner_pain_points"));
}

// ---------------------------------------------------------------------------
// Community-source quote rule: extractClaims relaxes the literal-substring
// requirement for source_type: "community_discussion". A paraphrased summary
// is allowed when ≥ 60% of significant tokens from the quote appear in the
// excerpt. Non-community sources keep the strict substring rule.
// ---------------------------------------------------------------------------

{
  const redditExcerpt =
    "I have been using Obsidian for three years to manage my notes. The plugin ecosystem is enormous: " +
    "I run Dataview, Templater, and the calendar plugin daily. Performance gets sluggish past 10000 notes.";

  installProvider((label) => {
    if (label !== "source_claim_extractor") {
      throw new Error(`community extractor fixture: unexpected label ${label}`);
    }
    return {
      claims: [
        // Paraphrased — NOT a substring, but every significant token appears.
        {
          claim: "Obsidian's plugin ecosystem is large and includes Dataview and Templater.",
          quote: "Obsidian plugin ecosystem enormous includes Dataview Templater calendar",
          architecture_family: "Obsidian",
          polarity: "supports",
          relevance: "on_topic",
          confidence: 0.8
        },
        // Tokens completely unrelated to excerpt — should be dropped.
        {
          claim: "Obsidian costs $200/year.",
          quote: "Obsidian subscription pricing premium tier enterprise license",
          architecture_family: "Obsidian",
          polarity: "neutral",
          relevance: "on_topic",
          confidence: 0.5
        }
      ]
    };
  });

  const communityClaims = await extractClaims({
    context: { domain: "PKM", decision: "knowledge store" },
    task: { id: "t1", title: "obsidian", objective: "Compare PKM tools" },
    source: {
      title: "r/ObsidianMD thread",
      url: "https://www.reddit.com/r/ObsidianMD/comments/xyz/",
      source_type: "community_discussion",
      excerpt: redditExcerpt
    }
  });
  assert.equal(
    communityClaims.length,
    1,
    `community source should accept paraphrased quote; got: ${JSON.stringify(communityClaims, null, 2)}`
  );
  assert.equal(communityClaims[0].claim, "Obsidian's plugin ecosystem is large and includes Dataview and Templater.");
  setLlmJsonProvider(null);

  // Non-community source with the SAME paraphrased quote — the strict
  // substring rule rejects it.
  installProvider((label) => {
    if (label !== "source_claim_extractor") {
      throw new Error(`strict extractor fixture: unexpected label ${label}`);
    }
    return {
      claims: [
        {
          claim: "Obsidian's plugin ecosystem is large.",
          quote: "Obsidian plugin ecosystem enormous includes Dataview Templater calendar",
          architecture_family: "Obsidian",
          polarity: "supports",
          relevance: "on_topic",
          confidence: 0.8
        }
      ]
    };
  });
  const strictClaims = await extractClaims({
    context: { domain: "PKM", decision: "knowledge store" },
    task: { id: "t1", title: "obsidian", objective: "Compare PKM tools" },
    source: {
      title: "Obsidian docs",
      url: "https://docs.obsidian.md/plugins",
      source_type: "official_docs",
      excerpt: redditExcerpt
    }
  });
  assert.equal(strictClaims.length, 0, "non-community source must enforce literal substring rule");
  setLlmJsonProvider(null);
}


// ---------------------------------------------------------------------------
// Clarification profiles — suggestProfiles ranks by signals, profiles carry
// flat tag arrays (not structured answers).
// ---------------------------------------------------------------------------

{
  const { suggestProfiles, profileById, profileTagsAsText } = await import(
    "../src/clarification-profiles.mjs"
  );

  // Solo founder with young codebase → pre_pmf_solo
  const soloSuggestions = suggestProfiles({
    contributorCount: 2,
    codebaseAgeDays: 14,
    complianceSignals: []
  });
  assert.ok(
    soloSuggestions.length > 0 && soloSuggestions[0].id === "pre_pmf_solo",
    `expected pre_pmf_solo first; got: ${soloSuggestions.map((p) => p.id).join(", ")}`
  );

  // Enterprise compliance signals → enterprise_regulated
  const enterpriseSuggestions = suggestProfiles({
    contributorCount: 25,
    codebaseAgeDays: 800,
    complianceSignals: ["HIPAA", "SOC2", "GDPR"]
  });
  assert.ok(enterpriseSuggestions.some((p) => p.id === "enterprise_regulated"));

  // profileById carries a flat tags array; profileTagsAsText renders them.
  const profile = profileById("pre_pmf_solo");
  assert.ok(profile && profile.label.toLowerCase().includes("pre-pmf"));
  assert.ok(Array.isArray(profile.tags) && profile.tags.length > 0, "profile carries tags array");
  assert.ok(profile.tags.includes("phase:pre_pmf"));
  assert.ok(profile.tags.includes("deployment:self_hosted_preferred"));
  const text = profileTagsAsText(profile);
  assert.ok(text.includes("## Context tags"));
  assert.ok(text.includes("phase:pre_pmf"));
}

// ---------------------------------------------------------------------------
// extractDecisionContext writes decision-context.json (annotations, never
// filters). The notes are surfaced via the context object for synthesis.
// ---------------------------------------------------------------------------

{
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "adr-decision-context-test-"));

  installProvider((label) => {
    assert.equal(label, "decision_context_extractor");
    return {
      notes: [
        {
          id: "self_hosted_preferred",
          category: "deployment",
          statement: "Self-hosted on Docker Compose is the primary deploy model.",
          evidence_from_input: "self-hosted is the primary deploy model"
        },
        {
          id: "soc2_planned",
          category: "compliance",
          statement: "SOC2 Type I planned in 12 months.",
          evidence_from_input: "SOC2 in 12 months"
        }
      ]
    };
  });

  const result = await extractDecisionContext({
    context: { domain: "saas", decision: "vector store" },
    content: "PRD: self-hosted is the primary deploy model. SOC2 in 12 months.",
    outDir: tmpDir,
    flags: {},
    tags: ["phase:early_revenue", "team:3-10"]
  });
  assert.equal(result.notes.length, 2);
  assert.equal(result.notes[0].id, "self_hosted_preferred");
  assert.deepEqual(result.tags, ["phase:early_revenue", "team:3-10"]);
  // File persisted so a re-run picks it up without an LLM call.
  const persisted = JSON.parse(await readFile(path.join(tmpDir, "decision-context.json"), "utf8"));
  assert.equal(persisted.notes.length, 2);
  assert.ok(Array.isArray(persisted.tags));
  setLlmJsonProvider(null);

  // Second call: cached from disk, no LLM call.
  installProvider(() => {
    throw new Error("LLM should NOT be called when decision-context.json exists");
  });
  const cached = await extractDecisionContext({
    context: { domain: "saas", decision: "vector store" },
    content: "irrelevant",
    outDir: tmpDir,
    flags: {}
  });
  assert.equal(cached.notes.length, 2);
  setLlmJsonProvider(null);

  await rm(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// proposeFollowUpQuestions: derives 2-3 sharper sub-decision questions from
// matrix axis variance.
// ---------------------------------------------------------------------------

{
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "adr-followup-test-"));

  installProvider((label) => {
    assert.equal(label, "follow_up_question_proposer");
    return {
      follow_ups: [
        {
          axis: "deployment_model",
          spread_score: 0.82,
          question: "Pick between self-hosted (Memgraph, Neo4j community) and managed (Neo4j Aura, Stardog Cloud) for the graph store.",
          suggested_command: "adr deep-research --decision 'Self-hosted vs managed graph store' --domain 'kg' --out .adr-runs/graph-store-deployment"
        },
        {
          axis: "pricing_model",
          spread_score: 0.6,
          question: "Compare predictable per-instance pricing vs query-based pricing for the graph store.",
          suggested_command: "adr deep-research --decision 'Pricing model for managed graph store' --domain 'kg' --out .adr-runs/graph-store-pricing"
        }
      ]
    };
  });

  const spec = {
    options: [
      { name: "memgraph", label: "Memgraph", strong_axes: ["deployment_model"], weak_axes: ["pricing_model"], evidence_depth: "medium" },
      { name: "neo4j_aura", label: "Neo4j Aura", strong_axes: ["pricing_model"], weak_axes: ["deployment_model"], evidence_depth: "medium" }
    ]
  };
  const comparisonMatrix = {
    axes: [
      { id: "deployment_model", label: "Deployment model" },
      { id: "pricing_model", label: "Pricing model" },
      { id: "ecosystem_health", label: "Ecosystem health" }
    ],
    cells: [
      { candidate: "memgraph", axis: "deployment_model", verdict: "strong" },
      { candidate: "neo4j_aura", axis: "deployment_model", verdict: "weak" },
      { candidate: "memgraph", axis: "pricing_model", verdict: "weak" },
      { candidate: "neo4j_aura", axis: "pricing_model", verdict: "strong" },
      { candidate: "memgraph", axis: "ecosystem_health", verdict: "mixed" },
      { candidate: "neo4j_aura", axis: "ecosystem_health", verdict: "mixed" }
    ]
  };

  const result = await proposeFollowUpQuestions({
    context: { domain: "kg", decision: "graph store" },
    spec,
    comparisonMatrix,
    outDir: tmpDir
  });
  assert.equal(result.follow_ups.length, 2);
  assert.equal(result.follow_ups[0].axis, "deployment_model");
  assert.ok(result.follow_ups[0].question.length > 10);
  assert.ok(result.follow_ups[0].suggested_command.includes("adr deep-research"));
  // Persisted artifact:
  const persisted = JSON.parse(await readFile(path.join(tmpDir, "follow-up-questions.json"), "utf8"));
  assert.equal(persisted.follow_ups.length, 2);

  setLlmJsonProvider(null);

  // Deferred mode → empty follow-ups, no LLM call.
  installProvider(() => {
    throw new Error("LLM should NOT be called when mode=deferred");
  });
  const deferredResult = await proposeFollowUpQuestions({
    context: { domain: "kg", decision: "graph store" },
    spec: { options: [] },
    comparisonMatrix: null,
    outDir: tmpDir
  });
  assert.equal(deferredResult.follow_ups.length, 0);
  setLlmJsonProvider(null);

  await rm(tmpDir, { recursive: true, force: true });
}

// ============================================================================
// Mermaid diagrams in the research report.
// ============================================================================
//
// Two checks cover the contract:
//   1. Happy path — LLM emits valid Mermaid for both decision_space_diagram
//      and per-option deployment_diagram. The synthesizer keeps both fields
//      and buildADR renders two ```mermaid fenced blocks.
//   2. Validation failure — LLM emits broken Mermaid (missing flowchart
//      header, triple-backtick contamination). The synthesizer drops the
//      bad fields, emits diagram_validation_failed, and the rest of the
//      report ships intact.
{
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "adr-diagrams-"));
  await writeFile(path.join(tmpDir, "events.jsonl"), "");

  const goodDecisionDiagram = `flowchart LR
  decision{Retrieval architecture}
  decision --> pgvector[Pgvector]
  decision --> pinecone[Pinecone]
  classDef thick fill:#cfc,stroke:#363
  class pgvector thick`;
  const goodDeploymentDiagram = `flowchart LR
  subgraph App
    api[API]
  end
  subgraph Data
    pg[(Postgres + pgvector)]
  end
  api -->|HNSW lookup| pg`;

  installProvider((label) => {
    assert.equal(label, "research_report_agent");
    return {
      id: "ADR-Retrieval",
      title: "Retrieval architecture",
      executive_summary: "Two candidates: pgvector and pinecone.",
      decision_space_diagram: goodDecisionDiagram,
      option_space_shape: "Self-host vs managed.",
      options: [
        {
          name: "pgvector",
          label: "Pgvector",
          summary: "Postgres extension.",
          evidence_depth: "thick",
          what_evidence_shows: "Production usage documented in Spring AI docs.",
          what_evidence_does_not_show: "No p99 latency at scale.",
          when_to_pick: ["You already run Postgres"],
          when_not_to_pick: ["You need >1B vectors"],
          strong_axes: ["fits_existing_stack"],
          weak_axes: ["scale"],
          citations: [1],
          deployment_diagram: goodDeploymentDiagram
        },
        {
          name: "pinecone",
          label: "Pinecone",
          summary: "Managed vector DB.",
          evidence_depth: "medium",
          what_evidence_shows: "Managed-service SDK and pricing docs.",
          what_evidence_does_not_show: "Vendor lock-in patterns.",
          when_to_pick: ["You want zero ops"],
          when_not_to_pick: ["You require on-prem"],
          strong_axes: ["scale"],
          weak_axes: ["fits_existing_stack"],
          citations: [2]
          // deployment_diagram omitted — synthesizer skipped it for this option
        }
      ],
      cross_cutting_tradeoffs: [],
      open_questions: [],
      domain_model: { bounded_contexts: [], core_entities: [], domain_invariants: [] },
      evidence_summary: {}
    };
  });

  const km = {
    acquisition_rule: "test rule",
    candidates: [
      { name: "pgvector", label: "Pgvector", evidence_depth: "thick", citations: [1], evidence_count: 3 },
      { name: "pinecone", label: "Pinecone", evidence_depth: "medium", citations: [2], evidence_count: 2 }
    ],
    off_topic_candidates: []
  };
  const evidence = [
    { citation_id: 1, title: "pgvector docs", url: "https://example.com/pgv", source_type: "official_docs", score: 0.9, excerpt: "...", claims: [], relevance: "x" },
    { citation_id: 2, title: "Pinecone docs", url: "https://example.com/pin", source_type: "official_docs", score: 0.8, excerpt: "...", claims: [], relevance: "x" }
  ];
  const context = {
    domain: "agents", decision: "retrieval architecture",
    domain_entities: [], bounded_contexts: [], query_shapes: [],
    operational_envelope: { latency: "not_specified", cost: "not_specified", scale: "not_specified", availability: "not_specified" },
    compliance_constraints: [], risk_invariants: []
  };

  const spec = await synthesizeDecisionPhase({
    context, knowledgeMap: km, evidenceItems: evidence, comparisonMatrix: null, outDir: tmpDir
  });

  // Happy-path assertions.
  assert.equal(spec.decision_space_diagram, goodDecisionDiagram, "decision_space_diagram preserved on happy path");
  const byName = Object.fromEntries(spec.options.map((o) => [o.name, o]));
  assert.equal(byName.pgvector.deployment_diagram, goodDeploymentDiagram, "pgvector deployment_diagram preserved");
  assert.equal(byName.pinecone.deployment_diagram, undefined, "omitted deployment_diagram stays omitted");

  // Renderer wraps each diagram in a ```mermaid fenced block.
  const md = buildADR(context, spec, km, evidence, {});
  const mermaidBlocks = md.match(/```mermaid\n[\s\S]*?\n```/g) || [];
  assert.equal(mermaidBlocks.length, 2, `expected 2 mermaid blocks in ADR.md, got ${mermaidBlocks.length}`);
  assert.ok(md.includes(goodDecisionDiagram), "decision_space_diagram appears in ADR.md");
  assert.ok(md.includes(goodDeploymentDiagram), "deployment_diagram appears in ADR.md");

  // No validation-failure event should have fired on the happy path.
  const happyEvents = (await readFile(path.join(tmpDir, "events.jsonl"), "utf8"))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(
    happyEvents.filter((e) => e.type === "diagram_validation_failed").length,
    0,
    "no diagram_validation_failed on happy path"
  );

  setLlmJsonProvider(null);

  // -- Sub-test 2: validation failure drops fields and emits event --
  const tmpDir2 = await mkdtemp(path.join(os.tmpdir(), "adr-diagrams-bad-"));
  await writeFile(path.join(tmpDir2, "events.jsonl"), "");

  installProvider(() => ({
    id: "ADR-Bad",
    title: "Retrieval architecture",
    executive_summary: "Two candidates with broken diagrams.",
    // Missing 'flowchart <dir>' header.
    decision_space_diagram: "graph LR\n  a --> b",
    option_space_shape: "x",
    options: [
      {
        name: "pgvector",
        label: "Pgvector",
        summary: "x",
        evidence_depth: "thick",
        what_evidence_shows: "x",
        what_evidence_does_not_show: "x",
        when_to_pick: ["x"],
        when_not_to_pick: ["x"],
        strong_axes: [],
        weak_axes: [],
        citations: [1],
        // Triple-backtick contamination — LLM wrapped its own answer.
        deployment_diagram: "```mermaid\nflowchart LR\n  api --> pg\n```"
      },
      {
        name: "pinecone",
        label: "Pinecone",
        summary: "x",
        evidence_depth: "medium",
        what_evidence_shows: "x",
        what_evidence_does_not_show: "x",
        when_to_pick: ["x"],
        when_not_to_pick: ["x"],
        strong_axes: [],
        weak_axes: [],
        citations: [2],
        // Unbalanced brackets.
        deployment_diagram: "flowchart LR\n  api[API --> pg[(Postgres)]"
      }
    ],
    cross_cutting_tradeoffs: [],
    open_questions: [],
    domain_model: { bounded_contexts: [], core_entities: [], domain_invariants: [] },
    evidence_summary: {}
  }));

  const badSpec = await synthesizeDecisionPhase({
    context, knowledgeMap: km, evidenceItems: evidence, comparisonMatrix: null, outDir: tmpDir2
  });

  // All three diagram fields should be dropped — the rest of the report intact.
  assert.equal(badSpec.decision_space_diagram, undefined, "broken decision_space_diagram dropped");
  const badByName = Object.fromEntries(badSpec.options.map((o) => [o.name, o]));
  assert.equal(badByName.pgvector.deployment_diagram, undefined, "broken pgvector deployment_diagram dropped");
  assert.equal(badByName.pinecone.deployment_diagram, undefined, "unbalanced pinecone deployment_diagram dropped");
  assert.equal(badSpec.options.length, 2, "options still present despite diagram failures");
  assert.ok(badSpec.executive_summary.length > 0, "executive_summary still present");

  // One diagram_validation_failed event with all 3 failures.
  const badEvents = (await readFile(path.join(tmpDir2, "events.jsonl"), "utf8"))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const failureEvents = badEvents.filter((e) => e.type === "diagram_validation_failed");
  assert.equal(failureEvents.length, 1, "one diagram_validation_failed event");
  assert.equal(failureEvents[0].failure_count, 3, "all 3 failures captured");
  const failureSections = failureEvents[0].failures.map((f) => f.section).sort();
  assert.deepEqual(
    failureSections,
    ["decision_space_diagram", "option:pgvector:deployment_diagram", "option:pinecone:deployment_diagram"],
    "failure sections recorded"
  );

  // ADR.md must NOT contain any mermaid fenced blocks (all dropped).
  const badMd = buildADR(context, badSpec, km, evidence, {});
  const badBlocks = badMd.match(/```mermaid\n[\s\S]*?\n```/g) || [];
  assert.equal(badBlocks.length, 0, "no mermaid blocks rendered when all diagrams failed validation");

  setLlmJsonProvider(null);

  // -- Sub-test 3: pure validator unit tests --
  assert.equal(validateMermaidSource("").ok, false);
  assert.equal(validateMermaidSource("not mermaid").ok, false);
  assert.equal(validateMermaidSource("flowchart LR\n  a --> b").ok, true);
  assert.equal(validateMermaidSource("flowchart TD\n  a{q} --> b[v]").ok, true);
  assert.equal(validateMermaidSource("```mermaid\nflowchart LR\n  a --> b\n```").ok, false);
  assert.equal(validateMermaidSource("flowchart LR\n  a[unbalanced --> b").ok, false);

  await rm(tmpDir, { recursive: true, force: true });
  await rm(tmpDir2, { recursive: true, force: true });
}

console.log("kernel regression tests ok");
