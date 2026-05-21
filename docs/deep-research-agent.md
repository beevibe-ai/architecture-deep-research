# Deep Research Agent

Architecture Deep Research is a live agentic research loop for strategic system design decisions.

The product constraint is strict:

- No offline research mode.
- No deterministic mock research.
- No static pattern library that forces the answer.
- Architecture candidates must be acquired from live evidence and synthesized with citations.

## Runtime Requirements

Every real ADR run needs both:

- A live search provider: `BRAVE_SEARCH_API_KEY`, `SERPER_API_KEY`, `TAVILY_API_KEY`, or `SEARXNG_URL`.
- An OpenAI-compatible LLM provider: `ADR_OPENAI_API_KEY` or `OPENAI_API_KEY`, with optional `ADR_OPENAI_BASE_URL`.

```bash
export BRAVE_SEARCH_API_KEY=...
export ADR_OPENAI_API_KEY=...
export ADR_MODEL=gpt-4.1-mini
```

## Flow

```text
Raw PRD / product context
        |
        v
Strategic Context Matrix
        |
        v
Planning Agent
        |
        v
Research Orchestrator
        |
        +--> Source acquisition agent: official docs
        +--> Source acquisition agent: mature OSS
        +--> Source acquisition agent: engineering writeups
        +--> Source acquisition agent: papers / benchmarks
        |
        v
Claim Extraction Agent
        |
        v
Evidence-Only Knowledge Map
        |
        v
Architecture Synthesis Agent
        |
        v
Adversarial Evaluation Pack Agent
        |
        v
Execution Handoff
```

The research loop is intentionally shallow: planner, orchestrator, research agents, claim extraction, synthesis. That shape keeps the agent powerful without burying evidence in nested conversations.

## Knowledge Acquisition Rule

ADR may extract domain hints from the PRD. It may not start from a forced architecture answer.

The `knowledge-map.json` file is the promotion boundary:

- `promoted_candidates`: architecture families with enough cited live evidence to be considered.
- `insufficient_evidence_candidates`: architecture families mentioned by sources but not strong enough to drive the decision.

If evidence is weak, the synthesis agent should choose `requires_human_architecture_review` rather than pretending certainty.

## CLI

```bash
npm run adr -- deep-research examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/logistics-contract-mesh \
  --max-cycles 2 \
  --max-sources 4
```

Outputs:

```text
events.jsonl
state.json
clarification.json
strategic-context.json
research-plan.json
evidence.json
knowledge-map.json
intermediate-reports.md
research-report.md
ADR.md
architecture.spec.json
domain-evaluation-pack.json
agent-guardrails.md
execution-handoff.json
sources.md
```

## Superseding Decisions

When implementation evidence or new research contradicts the current decision, generate a superseding ADR instead of silently changing topology:

```bash
npm run adr -- supersede .adr-runs/logistics-contract-mesh \
  --with ./new-product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/logistics-contract-mesh-v2 \
  --reason "New evidence shows the selected topology violates the latency envelope."
```

## Production Rules

- Research must use live search and source opening.
- Each evidence item keeps URL, source type, quality score, keyword hits, and extracted claims.
- Candidate architecture families are promoted only from cited claims.
- ADR stops at Execution Handoff.
- Implementation agents consume the handoff; they do not reinterpret the architecture without a superseding ADR.

## References

- Onyx deep research lessons: https://onyx.app/blog/building-the-best-deep-research
- Onyx repository: https://github.com/onyx-dot-app/onyx
