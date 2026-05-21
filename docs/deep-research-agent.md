# Deep Research Agent

Architecture Deep Research uses a shallow, production-oriented research agent loop inspired by the same design lessons Onyx published for its Deep Research system.

The point is not to build a giant multi-agent maze. The point is to keep each step simple, preserve evidence, and end with enforceable architecture state.

## Design Influences

Onyx describes a practical deep research stack with:

- A clarification stage.
- A planning agent that creates a high-level plan.
- An orchestrator that delegates to research agents.
- Research agents with search/open-url/internal-search tools.
- Intermediate reports with citations.
- A final report agent.
- Shallow depth: orchestrator plus research agents, not deeply nested agent chains.
- Reminders and citation instructions placed close to the relevant tool context.

ADR adopts the same shape, but specializes the final synthesis for architecture decisions.

## ADR Deep Research Flow

```text
Raw PRD / product context
        |
        v
Strategic Context Model
        |
        v
Planning Agent
        |
        v
Orchestrator
        |
        +--> Research Agent: DDD/domain fit
        +--> Research Agent: architecture precedent
        +--> Research Agent: failure modes
        +--> Research Agent: evaluation/enforcement
        |
        v
Intermediate Reports + Evidence
        |
        v
Architecture Synthesis
        |
        v
Execution Handoff
```

## Current CLI

```bash
npm run adr -- deep-research examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out /tmp/adr-deep-output \
  --max-cycles 2
```

Offline deterministic mode:

```bash
npm run adr -- deep-research examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out /tmp/adr-deep-output \
  --offline \
  --max-cycles 2
```

## Runtime Outputs

```text
events.jsonl
state.json
clarification.json
strategic-context.json
research-plan.json
evidence.json
intermediate-reports.md
research-report.md
ADR.md
architecture.spec.json
domain-evaluation-pack.json
agent-guardrails.md
execution-handoff.json
sources.md
```

## Durable State

Every deep research run writes:

- `events.jsonl`: append-only event log.
- `state.json`: terminal run state.
- `clarification.json`: missing-context assessment and targeted questions.
- `research-plan.json`: planner output.
- `evidence.json`: source-preserving evidence items.
- `intermediate-reports.md`: one report per research task.

This gives Beevibe, LangGraph, ADK, or custom adapters a stable surface for pause/resume, inspection, retries, and human review.

## Search And Retrieval

The CLI supports several source modes:

- `--offline`: deterministic seed-source mode for tests and demos.
- `--corpus-dir <dir>`: local internal search over markdown, text, JSON, and YAML files.
- `--seed-url <url>`: one or more seed URLs to open and cite.
- `BRAVE_SEARCH_API_KEY`: Brave Search.
- `SERPER_API_KEY`: Serper.
- `TAVILY_API_KEY`: Tavily.
- `SEARXNG_URL`: self-hosted SearXNG.

If no search provider is configured, ADR falls back to curated architecture seed URLs for RAG, GraphRAG, LangGraph, LlamaIndex, and Onyx-style deep research.

## Clarification

The first stage writes `clarification.json`. If the source brief is too thin, lacks domain entities, has no representative query shape, or omits important operational constraints, the file records targeted questions.

By default the CLI proceeds best-effort. To stop before research when clarification is needed:

```bash
npm run adr -- deep-research ./product-context.md \
  --domain "example domain" \
  --decision "retrieval topology" \
  --out /tmp/adr-deep-output \
  --strict-clarification
```

## Optional LLM Planning

The kernel can run without an LLM. By default it uses deterministic planning and synthesis so the artifact contract is testable.

For LLM-backed planning, set:

```bash
ADR_LLM_PROVIDER=openai-compatible
ADR_OPENAI_API_KEY=...
ADR_MODEL=...
```

Optional:

```bash
ADR_OPENAI_BASE_URL=http://localhost:1234/v1
```

The LLM is only an adapter for planning. Artifact validation, the Strategic Context Model, and the Execution Handoff boundary remain kernel-owned.

## Production Rules

- Keep agent depth shallow: orchestrator plus research agents.
- Never run more than three research agents in parallel.
- Preserve raw evidence excerpts before synthesis.
- Keep citations tied to source URLs.
- Use search/open-url as separate tools so the agent can inspect sources.
- Treat implementation as downstream execution, never part of the ADR loop.
- Feed evaluation/drift reports back only as evidence for a validating or superseding ADR.

## References

- Onyx deep research lessons: https://onyx.app/blog/building-the-best-deep-research
- Onyx chat context-management README: https://github.com/onyx-dot-app/onyx/blob/main/backend/onyx/chat/README.md
- Onyx repository: https://github.com/onyx-dot-app/onyx
