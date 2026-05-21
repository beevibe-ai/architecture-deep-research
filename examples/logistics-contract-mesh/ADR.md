# ADR-001: Retrieval And Reasoning Topology

Status: Proposed

Date: 2026-05-21

## Context

Beevibe is evaluating the architecture for a highly audited contract analysis engine for global logistics teams. The system must answer questions about vendors, facilities, shipment lanes, jurisdictions, contract clauses, and supply-chain exposure.

The product cannot treat documents as isolated blobs. Many target questions require linking facts across multiple contracts, appendices, policy documents, and external jurisdictional references.

Representative question:

```text
If maritime rules change for Rotterdam, which EMEA vendors are exposed through Tier-2 supplier contracts?
```

This query requires multi-hop traversal across geography, regulation, facility, vendor, contract, and clause entities. It also requires source-backed lineage so the answer can be reviewed.

## Decision

Use **Workflow-Routed Hybrid GraphRAG** as the primary retrieval and reasoning topology.

The system should combine:

- Deterministic workflow routing for query classification and execution.
- Graph-backed retrieval for entity and relationship traversal.
- Vector and lexical retrieval as bounded fallback tools.
- Source-span lineage checks before answers are returned.
- Agentic search only for exploratory analyst workflows, background enrichment, or unresolved research tasks.

## Rationale

### Multi-Hop Domain Shape

The core domain is relationship-heavy. Vendors, facilities, clauses, jurisdictions, and shipment lanes are not incidental metadata; they are the domain model. A pure vector retrieval system can find similar chunks, but it does not make the dependency graph first-class.

### Compliance And Traceability

The system must explain why an answer is valid. The answer path should resolve to source spans and graph node IDs. This makes GraphRAG and deterministic routing better aligned with the domain than an unconstrained agentic search loop.

### Operational Predictability

Compliance-critical answers should not depend on open-ended tool-calling loops. Agentic workflows can be useful, but the primary answer path needs bounded execution and predictable review semantics.

## Rejected Alternatives

### Naive Vector RAG

Rejected as the primary topology. It is simple to implement, but weak for relationship-heavy questions that require explicit traversal across multiple documents and domain entities.

### Pure Agentic Search

Rejected as the primary topology. It is flexible, but introduces non-deterministic latency, cost, and reasoning paths. Those trade-offs are unacceptable for compliance-critical contract answers.

### Graph-Only Retrieval

Rejected as a complete topology. Graph traversal is central, but the system still needs lexical and vector retrieval for ambiguity resolution, semantic search, and source discovery.

## Domain Boundaries

### ContractIngestionContext

Owns raw document import, document hashing, source span creation, and immutable ingestion records.

### GraphExtractionContext

Owns entity extraction, relationship extraction, ontology mapping, graph updates, and confidence scoring.

### QueryOrchestrationContext

Owns query classification, deterministic workflow routing, retrieval plan execution, and answer assembly.

### TraceabilityAuditContext

Owns citation validation, lineage checks, abstention rules, and audit records.

## Invariants

- Every answer must include source span IDs.
- Compliance-critical answers must include graph node IDs when graph traversal is used.
- The query orchestrator must not mutate ingestion state.
- Cross-context communication must happen through explicit interfaces or domain events.
- Agentic search must not be the primary compliance answer path.
- The system must abstain when source-backed lineage cannot be established.

## Consequences

This decision increases ingestion complexity and requires ontology discipline. In exchange, it gives the product a better fit for multi-hop legal/commercial reasoning, reviewable lineage, and deterministic execution.
