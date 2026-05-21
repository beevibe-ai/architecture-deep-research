# Beevibe Architecture Deep Research

**Deep research for strategic system design.**

Beevibe Architecture Deep Research, or **ADR**, is a flagship Beevibe project for answering the most expensive question in AI-assisted engineering:

> Given this product, domain, data shape, compliance envelope, team maturity, and operating budget, which architecture family should we bet on before a coding agent writes the first file?

Modern coding agents are excellent execution engines. Claude Code, Cursor, Codex, and similar tools can edit files, run tests, and iterate quickly. But they still tend to optimize for the immediate prompt and local code context. When the problem is strategic architecture, that creates a dangerous failure mode: the agent picks the easiest implementation path, not the architecture that fits the domain.

For retrieval-heavy systems, that failure often looks like this:

- A legal or medical system gets implemented as naive vector RAG because it is easy to scaffold.
- A workflow that needs deterministic routing becomes an open-ended ReAct loop.
- A domain with explicit entities and relationships gets flattened into anonymous chunks.
- A system that needs auditability ships without source lineage, abstention rules, or bounded context ownership.

Architecture Deep Research exists to move AI-assisted development up one layer. It does not try to be another coding assistant. It researches, compares, and turns architecture decisions into artifacts that humans can review and coding agents can obey.

## The Category

Architecture Deep Research is a dedicated **deep research layer for system design**.

It applies deep research to system design decisions, then turns the result into:

1. An Architecture Decision Record.
2. A machine-readable architecture spec.
3. A domain evaluation pack.
4. Coding-agent guardrails.
5. A source map of evidence, rejected alternatives, and trade-offs.

The goal is not a beautiful PDF. The goal is strategic alignment before implementation begins.

```text
Product context / PRD / constraints
              |
              v
      Architecture Deep Research
              |
      +-------+--------------------+
      |                            |
      v                            v
Architecture Spec          Domain Evaluation Pack
- selected topology        - representative tasks
- DDD boundaries           - query shape coverage
- rejected alternatives    - lineage expectations
- invariants               - SLA/cost envelopes
- agent guardrails         - abstention checks
```

## Why This Exists

The AI coding era has split software design into two different layers:

| Layer | Current Tools | What They Optimize For | Failure Mode |
| --- | --- | --- | --- |
| Implementation | Claude Code, Cursor, Codex, Copilot | File edits, tests, local correctness | Builds the wrong system quickly |
| Strategic architecture | Mostly human principal engineers | Domain fit, trade-offs, precedent, risk | Too slow, not consistently encoded for agents |

Architecture Deep Research targets the second layer.

The product insight is simple: once code generation becomes cheap, the scarce skill becomes choosing the right architecture family and preserving that decision through implementation.

## Example Decision: RAG vs Agentic Search vs GraphRAG

A normal coding prompt:

```text
Build a contract analysis engine for a logistics company.
```

A coding agent will often default to:

```text
PDF loader -> chunking -> embeddings -> top-k similarity search -> answer
```

That may pass a demo. It may even pass unit tests. But it can be structurally wrong if the real domain requires multi-hop reasoning across vendors, facilities, jurisdictions, contract clauses, shipment events, and changing regulatory constraints.

Architecture Deep Research researches the domain shape first:

| Pattern | Best Fit | Strategic Risk |
| --- | --- | --- |
| Naive Vector RAG | Self-contained documents, FAQ, docs search | Weak for relationship-heavy and multi-hop questions |
| Hybrid RAG | Keyword + vector retrieval with metadata filters | Strong baseline, but still limited when relationships are first-class |
| GraphRAG | Entity-heavy domains with explicit relationships and audit needs | Higher ingestion and ontology cost |
| Agentic Search | Open-ended investigation across tools and APIs | Non-deterministic latency, cost, and traceability |
| Workflow-Routed Hybrid | Production systems that need deterministic control with multiple retrieval modes | More design work upfront |

For a high-audit logistics contract mesh, the final decision might be:

```text
Decision:
Use Workflow-Routed Hybrid GraphRAG.

Why:
- Queries require multi-hop traversal across explicit business entities.
- Legal/commercial answers need deterministic source lineage.
- The domain has stable aggregates: Vendor, Facility, Contract, Clause, Jurisdiction, ShipmentLane.
- Open-ended agentic search is useful for analyst workflows but too non-deterministic for the primary answer path.

Rejected:
- Naive vector RAG as the primary topology.
- Pure agentic search for compliance-critical answers.

Guardrail:
Every answer must resolve to source document spans and graph node IDs before it can be returned.
```

## What The System Produces

### 1. ADR

A human-readable Architecture Decision Record:

```markdown
# ADR-004: Retrieval and Reasoning Topology

Status: Proposed

Decision: Workflow-Routed Hybrid GraphRAG

Context:
The product analyzes global logistics contracts and supply dependencies...

Rejected Alternatives:
- Naive Vector RAG
- Pure Agentic Search

Consequences:
- Higher ingestion complexity
- Stronger traceability
- More predictable query execution
```

### 2. Architecture Spec

A machine-readable contract for agents and implementation tooling:

```json
{
  "decision": {
    "selected_topology": "workflow_routed_hybrid_graphrag",
    "status": "proposed"
  },
  "domain_model": {
    "bounded_contexts": [
      "ContractIngestionContext",
      "GraphExtractionContext",
      "QueryOrchestrationContext",
      "TraceabilityAuditContext"
    ],
    "core_entities": [
      "Vendor",
      "Facility",
      "ContractClause",
      "Jurisdiction",
      "ShipmentLane"
    ]
  },
  "guardrails": {
    "forbidden_topologies": [
      "naive_vector_rag_primary_path",
      "unbounded_react_loop_primary_path"
    ],
    "required_invariants": [
      "All generated answers must include source span IDs.",
      "The query orchestrator may call retrieval tools but must not mutate ingestion state.",
      "Cross-context communication must happen through explicit interfaces or domain events."
    ]
  }
}
```

### 3. Domain Evaluation Pack

A benchmark pack that tests the architecture at the level where the decision actually matters:

```json
{
  "suite": "global_logistics_contract_mesh",
  "metrics": {
    "deterministic_lineage_rate": {
      "target": 0.98
    },
    "boundary_spill_tolerance": {
      "target": 0
    },
    "unsupported_answer_rate": {
      "target": 0
    }
  },
  "test_cases": [
    {
      "id": "TC-001",
      "type": "multi_hop_relational",
      "question": "Which vendors are exposed if maritime rules change for Rotterdam?",
      "expected_entities": ["Vendor", "Facility", "Jurisdiction", "ContractClause"],
      "minimum_citation_depth": 3,
      "abstention_rule": "Abstain if the answer cannot connect the facility, statute version, and contract clause through source-backed evidence."
    }
  ]
}
```

This is the benchmark shift. The product does not only ask, "Did the code run?" It asks, "Did the architecture preserve the domain invariants it was chosen for?"

### 4. Agent Guardrails

Instructions that can be handed to Claude Code, Codex, Cursor, or Beevibe agents:

```markdown
## Architecture Guardrails

- Do not implement naive top-k vector RAG as the primary answer path.
- Keep ingestion, graph extraction, query orchestration, and audit as separate bounded contexts.
- Every answer path must produce source span IDs and graph node IDs.
- Use deterministic workflow routing for compliance-critical queries.
- Use agentic search only for exploratory analyst workflows or background research.
```

## How It Works

Architecture Deep Research follows a research-to-spec pipeline.

### 1. Intake

The research engine ingests the strategic context:

- Product brief or PRD.
- Domain description.
- Representative user questions.
- Data shape and data sources.
- Compliance needs.
- Latency, cost, and reliability constraints.
- Team maturity and operational capacity.
- Existing stack preferences.

### 2. Decomposition

It decomposes the problem into architecture-relevant dimensions:

- Query shape: single-hop, multi-hop, exploratory, transactional, analytical.
- Data shape: documents, entities, events, relationships, time series, source-of-truth systems.
- Domain model: bounded contexts, aggregates, ownership, invariants.
- Risk profile: hallucination tolerance, auditability, privacy, availability, cost.
- Runtime behavior: synchronous vs asynchronous, deterministic vs agentic, batch vs online.

### 3. Deep Research

The research engine investigates proven patterns and failure modes across:

- Official framework documentation.
- Open-source implementations.
- Engineering blogs and production writeups.
- Papers and benchmark reports.
- Existing architecture decision records when available.

The research goal is not citation volume. The goal is pattern fit.

### 4. Pattern Selection

The research engine compares candidate architecture families:

- Vector RAG.
- Hybrid RAG.
- GraphRAG.
- Agentic search.
- Workflow-routed retrieval.
- Traditional search.
- Relational/domain-model-first systems.
- Staged migration paths.

It scores each candidate against domain constraints, operational cost, implementation complexity, traceability, and fit with DDD boundaries.

### 5. Spec Compilation

The selected decision is captured in durable artifacts:

- `ADR.md`
- `architecture.spec.json`
- `domain-evaluation-pack.json`
- `agent-guardrails.md`
- `sources.md`

These artifacts become the bridge between principal-engineer reasoning and agentic execution.

## Design Principles

### Strategic Before Tactical

The research engine chooses the architecture family before implementation begins. Lower-level choices still matter, but they happen after the topology is clear.

### Decisions Need Rejections

A useful ADR must explain what was rejected and why. Coding agents drift when rejected alternatives are not explicit.

### DDD Is A First-Class Signal

Architecture selection should respect bounded contexts, aggregate ownership, and domain invariants. The research engine treats boundary violations as design failures, not style issues.

### Evaluation Packs Are Product Assets

The domain evaluation pack is as important as the ADR. It turns vague architectural quality into repeatable checks.

### Agents Need Machine-Readable Constraints

A long report is not enough. The output must be structured so downstream agents can consume, enforce, and test against it.

## Initial Repository Shape

This repository starts with the artifact contracts and an example decision pack:

```text
.
├── README.md
├── docs/
│   └── schemas/
│       ├── architecture-spec.schema.json
│       └── domain-evaluation-pack.schema.json
└── examples/
    └── logistics-contract-mesh/
        ├── ADR.md
        ├── architecture.spec.json
        ├── domain-evaluation-pack.json
        └── agent-guardrails.md
```

Runtime code will come after the contracts are stable. That is intentional. This product is only valuable if the decision artifacts are crisp enough to guide humans and constrain agents.

## Roadmap

### Milestone 0: Artifact Contracts

- Define the ADR output format.
- Define the machine-readable architecture spec.
- Define the domain evaluation pack schema.
- Provide one high-quality reference example.

### Milestone 1: Research CLI

Target interface:

```bash
adr research ./product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out ./adr-output
```

Expected output:

```text
adr-output/
  ADR.md
  architecture.spec.json
  domain-evaluation-pack.json
  agent-guardrails.md
  sources.md
```

### Milestone 2: Beevibe Integration

- Run Architecture Deep Research as a Beevibe strategic research agent.
- Store ADRs as shared team memory.
- Attach architecture specs to implementation tasks.
- Inject guardrails into coding-agent sessions.

### Milestone 3: Evaluation Runner

- Run domain evaluation packs against candidate implementations.
- Score lineage, boundary spill, abstention, latency, and cost.
- Compare architecture families before production build-out.

### Milestone 4: Pattern Library

- Curated architecture families.
- Known failure modes.
- OSS and production precedents.
- Decision templates by domain.

## Relationship To Beevibe

Beevibe is the agent-native operating system for companies. Architecture Deep Research is the strategic architecture layer inside that vision.

Beevibe coordinates people and agents. Architecture Deep Research gives them better architecture decisions to coordinate around.

ADR fits Beevibe as a full product because the core Beevibe primitives already match what strategic architecture research needs:

- **Agent identity:** an Architect specialist is just a configured Beevibe Agent at the team or org level, with `hierarchy_level`, `parent_agent_id`, `runtime_config`, and `review_policy`.
- **Bounded domain memory:** architecture knowledge lives in the Architect's durable memory, where OSS precedents, DDD invariants, and failure-mode notes accumulate over time.
- **Mesh handoff:** when an IC coding agent reaches an architectural boundary, it asks the Architect through the mesh, receives a topology spec, and continues implementation under that constraint.
- **Hierarchy and review:** architectural constraints flow down with delegated tasks, while sensitive decisions can require human review.
- **Self-hosted privacy:** architecture context stays inside the same Beevibe workspace, Postgres database, daemon runtime, and MCP tool surface.

Beevibe is not an agent OS plus a separate ADR product. Beevibe is where ADR can become a real product, because deep architecture research needs persistent memory, specialist routing, hierarchy enforcement, human review, and private infrastructure.

In the long run, a Beevibe task should be able to carry:

- The product goal.
- The selected architecture decision.
- The DDD boundary map.
- The evaluation pack.
- The guardrails passed to coding agents.
- The source-backed reasoning behind the decision.

That turns AI-assisted development from "prompt and hope" into "research, decide, constrain, build, evaluate."

## References And Adjacent Work

This project builds on a visible shift across the ecosystem:

- Microsoft GraphRAG documents graph-based indexing and query workflows for retrieval over complex corpora.
- Neo4j GraphRAG emphasizes connected retrieval over graph structures.
- LangGraph provides stateful workflow and agent orchestration primitives.
- LlamaIndex exposes RAG, agent, workflow, and property-graph patterns as separate building blocks.
- ArchBench and related research benchmarks show that software architecture evaluation is becoming a distinct concern from code-generation evaluation.
- SWE-bench and LiveCodeBench remain important, but they mostly evaluate implementation correctness rather than strategic architecture selection.

Architecture Deep Research focuses on the missing layer between these pieces: choosing the right architecture family for the domain.

## Status

Early repository seed. The current focus is the product contract, artifact shape, and example decision packs.

## License

Apache-2.0.
