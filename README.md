# Beevibe Architecture Deep Research

**Deep research for strategic system design.**

Architecture Deep Research, or **ADR**, is a Beevibe flagship project for answering the architecture question that coding agents still handle badly:

> Given this product, domain, data shape, compliance envelope, team maturity, and operating budget, which architecture family should we bet on before a coding agent writes the first file?

Coding agents are excellent execution engines. They edit files, run tests, and iterate quickly. The failure mode is one layer higher: they often choose the easiest local implementation path before they understand the architecture family the product actually needs.

ADR is the missing deep research layer for that decision.

## Product Boundary

ADR does not implement the downstream product.

It researches architecture choices, acquires live evidence, synthesizes a decision, generates an evaluation pack, and hands off constraints to execution agents.

```text
Product brief / PRD
        |
        v
Architecture Deep Research
        |
        +--> live source acquisition
        +--> claim extraction
        +--> evidence-only knowledge map
        +--> architecture synthesis
        +--> adversarial evaluation pack
        |
        v
Execution Handoff
```

The handoff is where ADR stops. Beevibe, Claude Code, Cursor, Codex, or another coding agent consumes the constraints afterward.

## Hard Rules

- No offline research mode.
- No deterministic mock research.
- No static pattern library that forces the answer.
- Architecture candidates must be acquired from live source evidence.
- If evidence is insufficient, ADR should say so instead of inventing confidence.

## Why Beevibe

ADR fits Beevibe naturally because Beevibe already has the primitives that an architecture researcher needs:

- A configured Architect agent can be represented as a normal `Agent` row at team or org level.
- Durable agent memory can store OSS precedents, DDD invariants, and failure-mode notes.
- The mesh provides the handoff path: IC coding agents escalate architecture decisions to the Architect specialist.
- Human review policy can require sign-off before implementation.
- Self-hosting keeps product architecture, PRDs, and internal constraints private.

ADR is not a separate bolt-on tool. It is the strategic architecture specialist inside the Beevibe agent mesh.

## End-to-End Setup

Follow these eight steps in order. From clone to a finished ADR open in the Web UI takes ~5 minutes plus the run time.

### 1. Install

```bash
git clone https://github.com/beevibe-ai/architecture-deep-research.git
cd architecture-deep-research
npm install
```

Requires Node.js 20+ (see `engines` in `package.json`).

### 2. Set a live search provider (required, pick one)

ADR always uses live web search to gather evidence — there is no offline mode. **The same search machinery is shared by all three runtimes**; you only need to set one of the env vars below.

| Provider | Env var | Free tier | Sign-up |
| --- | --- | --- | --- |
| Brave Search | `BRAVE_SEARCH_API_KEY` | ~2k queries/month | https://api-dashboard.search.brave.com |
| Tavily | `TAVILY_API_KEY` | 1k requests/month | https://tavily.com |
| Serper (Google) | `SERPER_API_KEY` | 2.5k queries on signup | https://serper.dev |
| Self-hosted SearXNG | `SEARXNG_URL` | unlimited (your hardware) | https://docs.searxng.org |

```bash
export BRAVE_SEARCH_API_KEY=...   # or one of the other three
```

**Fallback: OpenAI `web_search`.** If none of the four above is set but `OPENAI_API_KEY` (or `ADR_OPENAI_API_KEY`) is set, ADR uses OpenAI's hosted `web_search` tool via the Responses API. One key then powers both LLM synthesis (Step 3 Option A) and search — useful when you don't want to manage a second provider. Dedicated search keys above always take priority.

If none of these is set, every runtime fails fast in `assertAgenticRuntime` with `No live search provider configured.`

### 3. Set an LLM provider (required, pick one to match your runtime)

The three runtimes share the same kernel and the same web search; they only differ in which LLM provider runs the JSON synthesis steps (planner, claim extractor, completeness judge, matrix filler, synthesizer, critique, citation verifier).

**Option A — OpenAI-compatible (default; CLI: `npm run adr`)**

Works with OpenAI, Azure OpenAI, vLLM, LM Studio, llamafile, Ollama with OpenAI-compatible wrapper, etc.

```bash
export ADR_OPENAI_API_KEY=...                       # or OPENAI_API_KEY
export ADR_MODEL=gpt-4.1-mini                       # default if unset
# Optional: point at a local OpenAI-compatible server
export ADR_OPENAI_BASE_URL=http://localhost:1234/v1
```

**Option B — LangGraph + LangChain `initChatModel` (CLI: `npm run adr:langgraph`)**

Any provider supported by LangChain's universal model initializer. Install the matching `@langchain/<provider>` package and set the provider's API key.

```bash
npm install @langchain/openai            # or @langchain/anthropic, @langchain/google-genai, @langchain/ollama, ...
export OPENAI_API_KEY=...                # whatever the provider needs
# Then pass --model provider:model on the CLI, e.g. openai:gpt-4.1-mini
```

Common `--model` strings: `openai:gpt-4.1-mini`, `anthropic:claude-3-5-sonnet-latest`, `google-genai:gemini-2.5-flash`, `bedrock:meta.llama3-70b-instruct-v1:0`, `ollama:llama3.1`, `groq:llama-3.3-70b-versatile`, `deepseek:deepseek-chat`.

**Option C — Google ADK / Gemini (CLI: `npm run adr:adk`)**

```bash
export GEMINI_API_KEY=...                # or GOOGLE_GENAI_API_KEY / GOOGLE_API_KEY
export ADR_ADK_MODEL=gemini-2.5-flash    # default; can be gemini-2.5-pro etc.
```

### 4. (Optional) GitHub token

ADR reads GitHub repos as repositories — README, ARCHITECTURE, top-level layout, stars, license, recent failure-mode issues — via the GitHub Contents API. Without auth, the rate ceiling is **60 calls/hour**, which gets hit fast on multi-repo runs.

```bash
export GITHUB_TOKEN=...   # lifts the ceiling to 5000/hr
```

Use a fine-grained token with read-only `public_repo` access; no scopes are needed beyond reading public repos.

### 5. Verify the install

```bash
npm test
```

Runs JSON schema validation + structural smoke for the kernel/adapters and the web UI server. Does **not** need any API keys or network — green here just means the wiring is intact.

### 6. Run your first ADR

Pick the runtime matching the LLM provider you set in step 3. All three produce the same artifact set in `--out`.

```bash
# Option A — OpenAI-compatible (default)
npm run adr -- deep-research examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/logistics-contract-mesh \
  --max-cycles 2 --max-sources 4

# Option B — LangGraph runtime
npm run adr:langgraph -- examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/logistics-langgraph \
  --model openai:gpt-4.1-mini

# Option C — Google ADK / Gemini runtime
npm run adr:adk -- examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/logistics-adk
```

A typical run takes 2–5 minutes (longer with more sources or with adaptive / adversarial cycles enabled). The CLI prints a summary on completion. See [What The Agent Produces](#what-the-agent-produces) for the full artifact list.

### 7. View the results in the Web UI

```bash
npm run web:build                                          # one-time: build the React UI
npm run adr:web -- --runs .adr-runs --port 4173 --open
```

The Web UI watches `.adr-runs/` and tails `events.jsonl` via Server-Sent Events, so you can also start it **before** launching a run and watch it progress live in either:

- **Operator mode** — Onyx-style product view: decision card, comparison matrix, plan, evidence panel, run-quality sidebar.
- **Developer mode** — Google ADK Dev UI-style: live event timeline, JSON inspector, per-artifact browser.

Toggle in the run-detail header. See [docs/web-ui.md](./docs/web-ui.md).

### 8. Common errors

| Error | Cause / fix |
| --- | --- |
| `No live search provider configured.` | Step 2: export one of `BRAVE_SEARCH_API_KEY` / `SERPER_API_KEY` / `TAVILY_API_KEY` / `SEARXNG_URL`. Or set only `OPENAI_API_KEY` to use the OpenAI `web_search` fallback. |
| `No LLM synthesis provider configured.` | Step 3: export the env vars for the runtime you launched. |
| `Google ADK deep research requires GEMINI_API_KEY...` | The ADK CLI is gated; even if `ADR_OPENAI_API_KEY` is set you must also set `GEMINI_API_KEY` (or `GOOGLE_GENAI_API_KEY`) to use `npm run adr:adk`. |
| Lots of GitHub 403 / 404 in `events.jsonl` | Step 4: set `GITHUB_TOKEN`. The unauthenticated 60/hr limit was hit. |
| LangGraph crashes inside `initChatModel` | The matching `@langchain/<provider>` package for your `--model` string isn't installed (e.g. `--model anthropic:...` needs `@langchain/anthropic`). |
| Web UI shows "no runs found" | Either no run has been started, or the server is pointed at a different directory than the CLI's `--out`. Use the same path for `--runs` and `--out`. |
| Tailwind warns "content option missing" | Run `npm run web:build` from the project root, not from inside `web/`. The Tailwind config resolves paths via `import.meta.url`. |

## Quick Start (TL;DR of the above)

```bash
git clone https://github.com/beevibe-ai/architecture-deep-research.git
cd architecture-deep-research
npm install

export BRAVE_SEARCH_API_KEY=...
export ADR_OPENAI_API_KEY=...
export ADR_MODEL=gpt-4.1-mini

npm run adr -- deep-research examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/logistics-contract-mesh

npm run web:build && npm run adr:web -- --open
```

## What The Agent Produces

### `architecture.spec.json`

Machine-readable architecture state:

- selected topology;
- bounded contexts;
- domain invariants;
- rejected alternatives;
- required guardrails;
- evidence citations.

### `knowledge-map.json`

Evidence-only architecture knowledge acquired during the run:

- promoted candidates;
- insufficient-evidence candidates;
- source types;
- citation IDs;
- support/warning/rejection claims.

This is not a hand-authored pattern library. It is a provenance record.

### `domain-evaluation-pack.json`

Adversarial test cases for the selected architecture:

- lineage checks;
- boundary-spill checks;
- multi-hop checks;
- abstention checks;
- agentic drift checks;
- latency or SLA expectations when available.

### `execution-handoff.json`

The machine-readable boundary object consumed by downstream agents. It states that ADR stops at Execution Handoff and lists the artifacts implementation agents must obey.

## Superseding ADRs

If implementation evidence, drift reports, or new research invalidates the decision, create a superseding ADR:

```bash
npm run adr -- supersede .adr-runs/logistics-contract-mesh \
  --with ./new-product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/logistics-contract-mesh-v2 \
  --reason "New evidence changes the topology decision."
```

The new run writes `supersedes.json` and appends a supersession section to the ADR.

## Web UI

A single web app with two modes, both reading the kernel's artifacts on disk:

- **Operator mode** — Onyx-style, product-facing. Decision card, comparison matrix, plan, evidence panel, run-quality sidebar.
- **Developer mode** — Google ADK Dev UI-style, observability-facing. Live event timeline (SSE tail of `events.jsonl`), JSON inspector, per-artifact browser.

```bash
npm run web:build                          # builds web/dist
npm run adr:web -- --runs .adr-runs --open # serves the UI + watches runs
```

See [docs/web-ui.md](./docs/web-ui.md).

## Framework Adapters

ADR keeps the kernel framework-neutral and exposes adapters:

- `adapters/langgraph.mjs`
- `adapters/google-adk.mjs`
- `adapters/beevibe.mjs`

LangGraph (full StateGraph runtime; LangChain `initChatModel` for the LLM):

```bash
npm run adr:langgraph -- examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/langgraph-logistics \
  --model openai:gpt-4.1-mini
```

The `--model` string is passed to LangChain's universal `initChatModel`. Examples: `openai:gpt-4.1-mini`, `google-genai:gemini-2.5-flash`, `anthropic:claude-3-5-sonnet-latest`, `ollama:llama3.1`. Install the matching `@langchain/<provider>` package.

Google ADK (Gemini as the LLM backend for the live agentic loop):

```bash
npm run adr:adk -- examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/adk-logistics-contract-mesh
```

Beevibe handoff:

```js
import { createBeevibeMeshHandoff } from "@beevibe/architecture-deep-research/adapters/beevibe";

const handoff = await createBeevibeMeshHandoff({
  outDir: ".adr-runs/logistics-contract-mesh"
});
```

## Benchmarks

Benchmarks are live agentic experiments. They require credentials and fail fast without them.

```bash
npm run benchmark:live:fast
npm run benchmark:live
```

Package tests are intentionally different:

```bash
npm test
```

`npm test` validates schemas and adapter wiring. It does not fake a deep research run.

## Repository Shape

```text
.
├── adapters/
│   ├── beevibe.mjs                       # Beevibe mesh handoff
│   ├── google-adk.mjs                    # ADK Agent + FunctionTool wrapper
│   ├── google-adk-deep-research.mjs      # ADK as the kernel's LLM provider
│   ├── langgraph.mjs                     # full StateGraph runtime
│   └── langgraph-llm.mjs                 # LangChain initChatModel JSON provider
├── benchmarks/
│   ├── configs/                          # live-fast.json, live.json
│   └── cases/
├── docs/
│   ├── deep-research-agent.md
│   ├── framework-adapters.md
│   ├── web-ui.md
│   ├── experiments.md
│   └── schemas/
├── examples/
│   └── logistics-contract-mesh/
├── scripts/
│   ├── adr.mjs                           # OpenAI-compatible CLI
│   ├── adr-langgraph.mjs                 # LangGraph CLI
│   ├── adr-adk.mjs                       # Google ADK / Gemini CLI
│   ├── adr-web.mjs                       # Web UI server
│   ├── benchmark.mjs
│   ├── check-json.mjs
│   ├── smoke-frameworks.mjs              # kernel + adapter smoke
│   └── smoke-web.mjs                     # web UI server smoke
├── sources/
│   └── manifest.json                     # curated source library per family
├── src/
│   └── kernel.mjs                        # the deep research kernel
└── web/                                  # Vite + React + Tailwind UI
    ├── src/
    ├── index.html
    ├── vite.config.js
    └── tailwind.config.js
```

## Status

This repo is the open-source core:

- live agentic research kernel;
- artifact schemas;
- framework adapters;
- benchmark harness;
- Beevibe mesh handoff adapter.

The commercial Beevibe surface can layer curated corpora, managed researcher agents, org-level memory, and team governance on top.
