# ADR-001: Retrieval Topology

Status: Proposed

## Context

Domain: global logistics contract analysis

Decision focus: retrieval topology

The Strategic Context Model identified these query shapes:

- multi_hop_relational: multi-hop, trace, relationship, exposed
- audit_traceability: audit, traceability, lineage, source, source-backed, compliance, legal
- exploratory_research: research
- self_contained_lookup: search, support

The core entities extracted from the brief are:

- Vendor
- Facility
- Contract
- ContractClause
- Jurisdiction
- ShipmentLane
- Claim
- Evidence
- Document
- User
- EMEA

## Decision

Use **Workflow-Routed Hybrid GraphRAG**.

Best fit for high-audit systems that need deterministic routing plus graph, lexical, and vector retrieval tools.

## Rationale

- Answers must resolve to source-backed evidence before being returned.
- The primary topology must preserve explicit relationships between domain entities.
- Compliance-critical flows must be deterministic, reviewable, and replayable.
- Agentic search must be bounded by workflow controls and must not silently mutate source-of-truth state.
- Bounded contexts must communicate through explicit interfaces or domain events.

## Rejected Alternatives

### Hybrid RAG

Good baseline for document search that needs lexical, vector, and metadata filtering.

Risks:
- Still limited when explicit relationships are the primary domain object.
- Can hide bounded-context ownership behind retrieval plumbing.

### GraphRAG

Strong for entity-heavy domains where relationships, traversal, and lineage are first-class.

Risks:
- Requires ontology discipline.
- Raises ingestion and extraction complexity.
- Can overfit if the domain does not have stable entities or relationships.

### Relational / Domain-Model-First

Best when source-of-truth transactions, aggregates, and ownership matter more than generative retrieval.

Risks:
- May under-serve exploratory knowledge questions.
- Can become too rigid when the corpus is unstructured and fast-changing.

### Agentic Search

Useful for exploratory research across tools, APIs, and changing information sources.

Risks:
- Non-deterministic latency and cost.
- Harder to audit and replay.
- Dangerous as the primary path for compliance-critical answers.

### Naive Vector RAG

Good for simple, self-contained document lookup where semantic similarity is enough.

Risks:
- Weak for relationship-heavy questions.
- Can lose source lineage when answers require cross-document joins.
- Easy for downstream agents to overuse because it is simple to scaffold.

## Bounded Contexts

- IngestionContext
- ExtractionContext
- DomainModelContext
- KnowledgeGraphContext
- QueryOrchestrationContext
- TraceabilityAuditContext

## Execution Handoff

ADR stops here. Downstream coding agents consume the architecture spec, guardrails, and evaluation pack. Implementation results may feed back as validation evidence, drift evidence, or grounds for a superseding ADR.
