# Agent Guardrails: Retrieval Topology

Selected topology: `workflow_routed_hybrid_graphrag`

## ADR Boundary

ADR has ended at Execution Handoff. Your job is to consume these constraints, not to reinterpret the architecture decision.

## Required Invariants

- Answers must resolve to source-backed evidence before being returned.
- The primary topology must preserve explicit relationships between domain entities.
- Compliance-critical flows must be deterministic, reviewable, and replayable.
- Agentic search must be bounded by workflow controls and must not silently mutate source-of-truth state.
- Bounded contexts must communicate through explicit interfaces or domain events.

## Forbidden Topologies

- naive_vector_rag_primary_path
- unbounded_react_loop_primary_path
- graph_or_vector_retrieval_without_source_spans

## Agentic Use

Agentic behavior is allowed only for:

- background research
- source discovery
- architecture comparison
- human-reviewed enrichment proposals

Do not replace the selected topology with an easier local implementation path without producing a superseding ADR.
