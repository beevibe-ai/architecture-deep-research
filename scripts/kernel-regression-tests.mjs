#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyCitationAudit,
  buildKnowledgeMap,
  buildStrategicContext,
  setLlmJsonProvider,
  synthesizeDecisionPhase,
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
    return {
      decision: {
        id: "ADR-X",
        title: "Retrieval Topology",
        status: "selected",
        selected_topology: "invented_topology",
        summary: "Invented topology should not clear the gate.",
        evidence_citations: [999]
      },
      domain_model: {},
      candidate_topologies: [
        {
          name: "invented_topology",
          fit: "Looks plausible but is not promoted.",
          risks: ["No promoted evidence."],
          decision: "Selected as primary topology.",
          evidence_citations: [999],
          confidence: "very high"
        }
      ],
      guardrails: {},
      evidence_summary: {}
    };
  });

  const gatedSpec = await synthesizeDecisionPhase({
    context,
    knowledgeMap: buildKnowledgeMap([]),
    evidenceItems: [],
    comparisonMatrix: null
  });

  assert.equal(gatedSpec.decision.selected_topology, "requires_human_architecture_review");
  assert.equal(gatedSpec.decision.status, "proposed");
  assert.equal(gatedSpec.candidate_topologies[0].decision, "deferred");
  assert.equal(gatedSpec.candidate_topologies[0].confidence, 0);
  assert.deepEqual(gatedSpec.candidate_topologies[0].evidence_citations, []);

  const citationDowngrade = applyCitationAudit({
    spec: {
      ...gatedSpec,
      decision: {
        ...gatedSpec.decision,
        selected_topology: "graphrag"
      }
    },
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
  assert.equal(
    citationDowngrade.spec.decision.selected_topology,
    "requires_human_architecture_review"
  );

  installProvider((label) => {
    if (label !== "evaluation_pack_agent") throw new Error(`unexpected label ${label}`);
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
    flags: { "skip-claim-audit": true }
  });
  await rm(outDir, { recursive: true, force: true });
} finally {
  setLlmJsonProvider(null);
}

console.log("kernel regression tests ok");
