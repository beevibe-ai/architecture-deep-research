# Architecture Deep Research Report

## Decision

ADR recommends **Workflow-Routed Hybrid GraphRAG** for **global logistics contract analysis**.

## Why This Fits

- Answers must resolve to source-backed evidence before being returned.
- The primary topology must preserve explicit relationships between domain entities.
- Compliance-critical flows must be deterministic, reviewable, and replayable.
- Agentic search must be bounded by workflow controls and must not silently mutate source-of-truth state.
- Bounded contexts must communicate through explicit interfaces or domain events.

## Research Coverage

- R1: Domain shape and DDD fit
- R2: Retrieval topology precedent
- R3: Failure modes and rejected alternatives
- R4: Evaluation and enforcement

## Evidence Summary

- [1] https://microsoft.github.io/graphrag/: Seed source for architecture research query: global logistics contract analysis DDD bounded contexts architecture retrieval topology...
- [2] https://neo4j.com/labs/genai-ecosystem/graphrag/: Seed source for architecture research query: global logistics contract analysis DDD bounded contexts architecture retrieval topology...
- [3] https://microsoft.github.io/graphrag/: Seed source for architecture research query: GraphRAG official architecture entity relationship retrieval...
- [4] https://neo4j.com/labs/genai-ecosystem/graphrag/: Seed source for architecture research query: GraphRAG official architecture entity relationship retrieval...
- [5] https://microsoft.github.io/graphrag/: Seed source for architecture research query: naive vector RAG failure modes multi hop traceability...
- [6] https://neo4j.com/labs/genai-ecosystem/graphrag/: Seed source for architecture research query: naive vector RAG failure modes multi hop traceability...
- [7] https://microsoft.github.io/graphrag/: Seed source for architecture research query: RAG evaluation lineage citation abstention multi-hop benchmark...
- [8] https://neo4j.com/labs/genai-ecosystem/graphrag/: Seed source for architecture research query: RAG evaluation lineage citation abstention multi-hop benchmark...

## Intermediate Reports

## R1: Domain shape and DDD fit

Objective: Determine which architecture families fit global logistics contract analysis, focusing on entities Vendor, Facility, Contract, ContractClause, Jurisdiction, ShipmentLane, Claim, Evidence and bounded-context ownership.

Findings:
- [1] https://microsoft.github.io/graphrag/: Seed source for architecture research query: global logistics contract analysis DDD bounded contexts architecture retrieval topology...
- [2] https://neo4j.com/labs/genai-ecosystem/graphrag/: Seed source for architecture research query: global logistics contract analysis DDD bounded contexts architecture retrieval topology...

## R2: Retrieval topology precedent

Objective: Compare Hybrid RAG, Workflow-Routed Hybrid GraphRAG, GraphRAG, Relational / Domain-Model-First, Agentic Search, Naive Vector RAG using official docs and known production precedents.

Findings:
- [1] https://microsoft.github.io/graphrag/: Seed source for architecture research query: GraphRAG official architecture entity relationship retrieval...
- [2] https://neo4j.com/labs/genai-ecosystem/graphrag/: Seed source for architecture research query: GraphRAG official architecture entity relationship retrieval...

## R3: Failure modes and rejected alternatives

Objective: Find evidence for why tempting simpler patterns fail under auditability, lineage, multi-hop, latency, or operational constraints.

Findings:
- [1] https://microsoft.github.io/graphrag/: Seed source for architecture research query: naive vector RAG failure modes multi hop traceability...
- [2] https://neo4j.com/labs/genai-ecosystem/graphrag/: Seed source for architecture research query: naive vector RAG failure modes multi hop traceability...

## R4: Evaluation and enforcement

Objective: Identify evaluation metrics and guardrails that can prove the selected architecture preserves its domain invariants.

Findings:
- [1] https://microsoft.github.io/graphrag/: Seed source for architecture research query: RAG evaluation lineage citation abstention multi-hop benchmark...
- [2] https://neo4j.com/labs/genai-ecosystem/graphrag/: Seed source for architecture research query: RAG evaluation lineage citation abstention multi-hop benchmark...


## Citation Reminder

Evidence-backed claims in downstream ADR revisions should cite source IDs such as [1], [2], [3], [4], [5], [6], [7], [8]. The artifacts preserve excerpts and URLs so weak or contradictory evidence can be audited.

## Boundary

ADR stops at Execution Handoff. The report supports architecture selection; it does not authorize the research agent to implement the product.
