# Deep Research Agent

Architecture Deep Research is a live agentic research loop for strategic system design decisions.

## Why this is not a generic deep-research agent

In the vibe coding era, code generation is cheap; the bottleneck is **whether the right architecture was chosen at all**. General deep-research agents (OpenAI, Anthropic, Gemini, Perplexity, LangChain `open_deep_research`) average over consensus blog posts and produce a long-form report. ADR refuses to do that. Our flagship is producing the **fair, OSS- and paper-grounded architecture comparison that no human writes and no general deep-research agent does**:

- **Code-aware research.** GitHub URLs are inspected as repositories (README, ARCHITECTURE.md, top-level layout, stars, last push, license, recent failure-mode issues) — not stripped to 1600-char text excerpts.
- **Paper-aware research.** arXiv / OpenReview / ACL / ACM / IEEE / bioRxiv URLs are digested into structured `{problem, methodology, datasets, baselines, headline_results, measured_results, ablations, limitations, conflicts_of_interest}` — using full HTML/PDF text when available, and marking abstract-only digests so measured results cannot be overclaimed.
- **Comparison matrix, not just a report.** The primary research artifact is `comparison-matrix.json`: candidates × axes derived from the Strategic Context Matrix, every cell carrying a `strong`/`mixed`/`weak`/`no_evidence` verdict and citation_ids. Empty cells are tracked.
- **Adversarial per-candidate research.** When the matrix has empty cells, an adversarial planner generates "find the strongest case AGAINST candidate X" tasks. Production incidents, latency stories, ecosystem decline. The matrix is re-built after each adversarial cycle.
- **Evidence-only promotion gate.** A candidate only reaches the synthesizer when the knowledge map has ≥2 cited evidence items including ≥1 from `official_docs` / `mature_oss` / `paper_or_benchmark`. `requires_human_architecture_review` is a first-class output when evidence is weak.

The product constraint is strict:

- No offline research mode.
- No deterministic mock research.
- No static pattern library that forces the answer.
- Architecture candidates must be acquired from live evidence and synthesized with citations.
- The comparison matrix is the synthesizer's primary input; raw evidence is the audit trail, not the substitute.

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
        |       search -> dispatch:
        |                  - GitHub URL  -> inspectGithubRepo (README, ARCHITECTURE,
        |                                   issues, stars, last push, license)
        |                  - arXiv/ACL/IEEE/ACM -> digestPaper (problem, methodology,
        |                                          datasets, baselines, headline vs
        |                                          measured results, limitations,
        |                                          conflicts of interest)
        |                  - else       -> openUrl (HTML to text)
        |       -> extract claims
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
Comparison Matrix Builder
        |
        +-- empty cells or weak coverage? --> Adversarial per-candidate planner
        |                                              |
        |                                              v
        |                                   targeted "against X" research,
        |                                   then re-build matrix
        |
        v
Architecture Synthesis Agent  (consumes the matrix, not the raw pool)
        |
        v
Critique Agent (flags uncited claims, contradictions, weak evidence)
        |
        v
Citation Verifier (per-citation supported/unsupported verdict)
        |
        v
Adversarial Evaluation Pack Agent
        |
        v
Execution Handoff
```

The flagship moves are research-quality moves:

- **Code-aware evidence.** When a research agent surfaces a `github.com/<owner>/<repo>` URL, `inspectGithubRepo` reads it as a repository, not a blog post: README + ARCHITECTURE/docs entries, top-level directory layout, stars, forks, last push, license, topics, and recent closed issues filtered for failure-mode keywords. The evidence item carries the `repo_digest` for downstream auditability. With `GITHUB_TOKEN` set, the rate limit jumps from 60/hr to 5000/hr.
- **Paper-aware evidence.** When a URL points to arXiv / OpenReview / ACL / ACM / IEEE / bioRxiv, `digestPaper` extracts structured `{problem, methodology, datasets, baselines, headline_results, measured_results, ablations, limitations, conflicts_of_interest}` rather than slicing 1600 chars of HTML. Distinguishes "what the abstract claims" from "what the paper actually measured".
- **Comparison matrix as the primary input to synthesis.** Before the synthesizer picks a topology, `compareTopologiesPhase` builds `comparison-matrix.json`: rows = candidates (from the knowledge map), columns = axes (derived from `query_shapes`, `risk_invariants`, `operational_envelope`, `compliance_constraints`). Each cell carries a verdict (`strong`/`mixed`/`weak`/`no_evidence`) and citation_ids. Empty cells are tracked.
- **Adversarial per-candidate research.** When the matrix has empty cells or weak coverage, a per-candidate adversarial planner generates "find the strongest case AGAINST X" tasks. Production incidents, latency stories, lineage limitations, ecosystem decline. The matrix is re-built after each adversarial cycle. Bounded by `--max-adversarial-cycles` (default 1).
- **Per-task inner loop.** Each research agent runs up to `--max-rounds` rounds (default 2) with a completeness judge proposing follow-up queries when evidence is thin.
- **Adaptive outer cycle.** If the knowledge map has no `promoted_candidates`, an adaptive gap-filling planner generates 2–4 new tasks. Bounded by `--max-adaptive-cycles` (default 1).
- **Critique pass + citation / claim verifiers.** Critique flags uncited claims, contradictions, weak evidence, and unbacked selections. Citation verifier walks every `evidence_citations` reference and unsupported selected-topology citations downgrade to human review by default. Claim audit scans generated ADR/report/eval artifacts for uncited material claims.

These keep the orchestrator/researcher topology shallow (no nested sub-agents) while turning the loop into one that actually distinguishes good architectures from merely popular ones.

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
- `--max-adversarial-cycles <n>` (default 1): max adversarial per-candidate cycles when the comparison matrix has empty cells.
- `--skip-comparison-matrix`: skip the comparison-matrix phase (and the adversarial per-candidate research that depends on it).
- `--skip-critique`: do not run the critique agent.
- `--no-enforce-critique`: opt out of the default downgrade when high-severity critique recommends human review.
- `--skip-citation-audit`: do not run the post-hoc citation verifier.
- `--no-enforce-citation-audit`: opt out of the default downgrade when selected-topology citations are unsupported.
- `--skip-claim-audit`: do not scan generated ADR/report/eval artifacts for uncited material claims.
- `--plan-approval` (LangGraph runtime only): pause after planning so the operator can edit `research-plan.json` and resume programmatically.
- `--strict-clarification`: stop before research if the PRD is too thin.

### Optional env

- `GITHUB_TOKEN`: lifts the unauthenticated 60/hr GitHub API ceiling to 5000/hr. Required in practice for any run that surfaces multiple GitHub URLs.
- `ADR_MCP_SERVER_URL`: optional read-only remote MCP corpus searched through OpenAI hosted MCP. Use `ADR_SEARCH_PROVIDER=mcp` or `ADR_PRIVATE_MCP_ONLY=1` to force private-corpus search.

Outputs:

```text
events.jsonl
state.json
clarification.json
strategic-context.json
research-plan.json
research-plan.adaptive-<n>.json    (one per gap-filling cycle, if any)
research-plan.adversarial-<n>.json (one per adversarial cycle, if any)
evidence.json
knowledge-map.json
comparison-matrix.json
intermediate-reports.md
critique.json
citation-audit.json
claim-audit.json
research-report.md
ADR.md
architecture.spec.json
domain-evaluation-pack.json
agent-guardrails.md
execution-handoff.json
sources.md
cost.json
source-snapshots/
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
- Each evidence item keeps URL, source type, quality score, keyword hits, extracted claims, retrieval timestamp, content hash, fetch status, and a raw-text snapshot path when available.
- Candidate architecture families are promoted only from cited claims.
- ADR stops at Execution Handoff.
- Implementation agents consume the handoff; they do not reinterpret the architecture without a superseding ADR.

## References

- Onyx deep research lessons: https://onyx.app/blog/building-the-best-deep-research
- Onyx repository: https://github.com/onyx-dot-app/onyx
