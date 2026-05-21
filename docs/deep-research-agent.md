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
- An LLM provider for JSON synthesis. Three backends are supported:
  - **OpenAI-compatible** (default): `ADR_OPENAI_API_KEY` or `OPENAI_API_KEY`, with optional `ADR_OPENAI_BASE_URL`.
  - **LangChain via the LangGraph runtime**: any provider supported by LangChain's `initChatModel` (OpenAI, Anthropic, Google, Bedrock, Mistral, Ollama, Groq, DeepSeek, ...). Run through the `adr:langgraph` CLI with `--model provider:model` or call `setLlmJsonProvider(createLangChainJsonProvider({ model }))` before `deepResearch`. See [framework-adapters.md](./framework-adapters.md#langgraph).
  - **Gemini via Google ADK**: `GEMINI_API_KEY` or `GOOGLE_GENAI_API_KEY`. Run through the `adr:adk` CLI or call `setLlmJsonProvider(createAdkJsonProvider({ model }))` before `deepResearch`. See [framework-adapters.md](./framework-adapters.md#google-adk).

```bash
export BRAVE_SEARCH_API_KEY=...
export ADR_OPENAI_API_KEY=...
export ADR_MODEL=gpt-4.1-mini

# or, for the Gemini / ADK runtime:
export BRAVE_SEARCH_API_KEY=...
export GEMINI_API_KEY=...
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
        +--> Source acquisition agent (per-task iterative loop)
        |       search -> open -> extract claims
        |              ^                |
        |              |  completeness  |
        |              +-- judge <------+
        |
        v
Claim Extraction Agent
        |
        v
Evidence-Only Knowledge Map
        |
        +-- no promoted candidates? --> Adaptive gap-filling planner
        |                                       |
        |                                       v
        |                              run additional research cycle
        |
        v
Architecture Synthesis Agent
        |
        v
Critique Agent (flags uncited claims, contradictions, weak evidence)
        |
        v
Adversarial Evaluation Pack Agent
        |
        v
Execution Handoff
```

The research loop is shallow but iterative:

- **Per-task inner loop.** Each research agent runs up to `--max-rounds` rounds (default 2). After each round a completeness judge LLM decides whether the task objective is answered or proposes 1–3 follow-up queries.
- **Adaptive outer cycle.** If the knowledge map has no `promoted_candidates` after the initial plan, an adaptive gap-filling planner generates 2–4 new tasks and the research phase runs again (up to `--max-adaptive-cycles`, default 1).
- **Critique pass.** A critique agent reads the synthesized spec, the knowledge map, and the evidence pool, and writes `critique.json` flagging uncited claims, contradictions, weak evidence, or selected topologies not actually backed by promoted candidates. With `--enforce-critique`, high-severity issues automatically downgrade the decision to `requires_human_architecture_review`.

These keep the orchestrator/researcher topology shallow (no nested sub-agents) while making the loop actually adaptive to evidence quality.

## Knowledge Acquisition Rule

ADR may extract domain hints from the PRD. It may not start from a forced architecture answer.

The `knowledge-map.json` file is the promotion boundary:

- `promoted_candidates`: architecture families with enough cited live evidence to be considered.
- `insufficient_evidence_candidates`: architecture families mentioned by sources but not strong enough to drive the decision.

If evidence is weak, the synthesis agent should choose `requires_human_architecture_review` rather than pretending certainty.

## CLI

OpenAI-compatible runtime (default):

```bash
npm run adr -- deep-research examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/logistics-contract-mesh \
  --max-cycles 2 \
  --max-sources 4
```

LangGraph runtime (full StateGraph orchestration; LLM via LangChain `initChatModel`):

```bash
npm run adr:langgraph -- examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/langgraph-logistics \
  --model openai:gpt-4.1-mini \
  --max-cycles 2 \
  --max-sources 4
```

Gemini / Google ADK runtime (same kernel pipeline, ADK-driven LLM backend):

```bash
npm run adr:adk -- examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/adk-logistics-contract-mesh \
  --max-cycles 2 \
  --max-sources 4
```

### Tuning flags

- `--max-rounds <n>` (default 2): max search-judge rounds per research task.
- `--max-sources <n>` (default 5): max evidence items per task.
- `--max-cycles <n>` (default 2): bound on planned task count.
- `--max-adaptive-cycles <n>` (default 1): max gap-filling re-research cycles when the knowledge map has no promoted candidates.
- `--skip-critique`: do not run the critique agent.
- `--enforce-critique`: when set, high-severity critique with `recommend_human_review` auto-downgrades the selected topology to `requires_human_architecture_review` (original choice preserved in `state.json`).
- `--strict-clarification`: stop before research if the PRD is too thin.

Outputs:

```text
events.jsonl
state.json
clarification.json
strategic-context.json
research-plan.json
research-plan.adaptive-<n>.json   (one per gap-filling cycle, if any)
evidence.json
knowledge-map.json
intermediate-reports.md
critique.json
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
