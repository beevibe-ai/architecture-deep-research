# Agent Guardrails: Logistics Contract Mesh

These rules are intended for Claude Code, Codex, Cursor, or Beevibe agents implementing the selected architecture.

## Selected Topology

Use Workflow-Routed Hybrid GraphRAG.

## Do Not Build

- Do not implement naive top-k vector RAG as the primary compliance answer path.
- Do not implement an unbounded ReAct loop as the primary compliance answer path.
- Do not let the LLM connect directly to databases or mutate state outside application services.
- Do not collapse ingestion, graph extraction, query orchestration, and audit into one module.

## Required Boundaries

- `ContractIngestionContext` owns raw documents, hashes, and source spans.
- `GraphExtractionContext` owns entities, relationships, ontology mapping, and graph updates.
- `QueryOrchestrationContext` owns query classification, routing, retrieval, and answer assembly.
- `TraceabilityAuditContext` owns lineage validation, abstention, and audit records.

## Required Answer Behavior

- Every answer must include source span IDs.
- Graph-backed answers must include graph node IDs.
- Compliance-critical queries must run through deterministic workflow routing.
- The system must abstain when source-backed lineage cannot be established.

## Allowed Agentic Behavior

Agentic search may be used for:

- Analyst exploration.
- Background research.
- Source discovery.
- Ontology enrichment proposals.

Agentic search must not be used as the primary compliance answer path unless a later ADR explicitly changes this decision.
