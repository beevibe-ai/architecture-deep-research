# Beevibe Architecture Deep Research

**Live, evidence-only research for system-design decisions.**

ADR answers the question coding agents still handle badly:

> Given this product, domain, data shape, compliance envelope, team maturity, and operating budget — which architecture family should we bet on before a coding agent writes the first file?

Coding agents are excellent execution engines. They edit files, run tests, iterate quickly. The failure mode is one layer higher: they pick the easiest local implementation path before they understand the architecture family the product actually needs.

ADR is the missing research layer for that decision.

```text
PRD / repo  →  research plan  →  live source acquisition  →  knowledge map
            →  comparison matrix  →  synthesis  →  citation + claim audit
            →  evaluation pack  →  execution handoff  →  coding agent
```

The handoff is where ADR stops. Claude Code, Cursor, Codex, or a Beevibe specialist consumes the constraints afterward.

## Hard Rules

- No offline research mode.
- No deterministic mock research.
- No static pattern library that forces the answer.
- Architecture candidates must come from live source evidence.
- ADR produces a **ranked option set with explicit tradeoffs**, not a single forced winner. A `recommendation` is populated only when one option clearly dominates the comparison matrix; otherwise the mode is `ranked_options` and the caller picks based on team-side constraints ADR cannot know. When no candidate clears the promotion gate at all, the mode is `deferred` — re-run with sharper context.

## Three Ways In

All three surfaces share the same kernel and produce the same artifact set.

### 1. Claude Code plugin (recommended for normal users)

```bash
claude plugin marketplace add beevibe-ai/architecture-deep-research
claude plugin install adr
```

Then in any session:

| Slash | What it does |
| --- | --- |
| `/adr:doctor` | One-time: audit env, walk through API key setup, persist to `~/.adr/config.json` |
| `/adr:decide` | Ask a decision name, scan the repo, run the full pipeline, summarize the handoff |
| `/adr:discover` | Quick scan only — drafts a PRD without the full deep-research run |

The plugin registers the MCP server automatically. The doctor's persistent config means you never need to re-export keys in the shell that launches Claude Code.

### 2. MCP server (Cursor, Codex, Beevibe, any MCP host)

```bash
npm install -g github:beevibe-ai/architecture-deep-research
adr-doctor setup
```

Add to your host's MCP config:

```json
{ "mcpServers": { "adr": { "command": "adr-mcp" } } }
```

Three tools become available:

- `adr_discover({ repo_path, decision, out_dir, issue_body? })` — scan only
- `adr_deep_research({ domain, decision, out_dir, discover_first?, input_path?, repo_path?, max_cycles?, max_sources?, issue_body? })` — full pipeline (with optional chained discover)
- `adr_read_handoff({ out_dir })` — convenience reader for `execution-handoff.json`

The server boots in milliseconds over stdio.

### 3. CLI (terminal, CI, GitHub Action)

```bash
npm install -g github:beevibe-ai/architecture-deep-research
adr-doctor            # audit env, exits non-zero if anything is missing

# Discover + deep-research in one command
adr deep-research --discover-first \
  --repo . --domain "internal-tools" --decision "event bus topology" \
  --out .adr-runs/event-bus

# Or two-step: scan, edit the draft, then run
adr discover --repo . --decision "event bus topology" --out .adr-runs/discover
$EDITOR .adr-runs/discover/pdr.draft.md     # fill in the Open questions
adr deep-research .adr-runs/discover/pdr.draft.md \
  --domain "internal-tools" --decision "event bus topology" \
  --out .adr-runs/event-bus-deep
```

> `npm install -g github:...` installs straight from this GitHub repo — no npm registry account required. A published `@beevibe/architecture-deep-research` package on npmjs.com may follow.

## Ranked Options, Not a Single Forced Winner

Every architecture decision is a tradeoff. ADR's primary output is a **ranked option set** — every viable candidate from the comparison matrix appears with explicit `when_to_pick` / `when_not_to_pick` conditions, `strong_axes` / `weak_axes`, and per-option `required_invariants` and `forbidden_topologies`.

A `recommendation` is added only when one option clearly dominates (strong on multiple axes that matter AND others are weak or no_evidence on at least one critical axis). When no option dominates, `mode = "ranked_options"` and the caller picks based on team-side constraints ADR cannot know (existing infrastructure, hiring plans, vendor relationships, budget envelope).

| Mode | Meaning |
| --- | --- |
| `recommended` | One option dominates; `recommendation.name` names it. The other options are recorded with their tradeoffs as alternatives. |
| `ranked_options` | Multiple options are viable with genuine tradeoffs. `recommendation: null`. Pick the option whose conditions match your situation. |
| `deferred` | No candidate cleared the promotion gate. Re-run with sharper context. |

Coding agents downstream pick one option, then honor the matching block in `agent-guardrails.md` (per-option contract). The handoff JSON's `options[]` is the machine-readable equivalent.

## Decision Kind: Family vs Concrete

ADR distinguishes two kinds of decisions and adapts accordingly:

| Mode | When | Candidates are | Extra matrix axes |
| --- | --- | --- | --- |
| `family` | "retrieval topology", "event bus architecture", "consistency model" | architecture patterns ("graph_retrieval", "token_based_auth") | none (default axes only) |
| `concrete` | "auth provider", "queue library", "logging vendor" | specific products ("Clerk", "BullMQ", "Datadog") | pricing model, vendor lock-in, SDK quality, on-prem availability, ecosystem health |

ADR auto-detects from the decision name: keywords like `provider`, `vendor`, `library`, `service`, `platform`, `tool`, `sdk` switch to `concrete`. Override explicitly via the CLI:

```bash
adr deep-research --decision-kind concrete --decision "auth provider" ...
```

The MCP tool takes the same value via the `decision_kind` arg. The `/adr:decide` slash command asks the user to confirm before running.

This was a real bug in earlier versions: asking ADR for an "auth provider" got back "token-based auth" (a pattern) instead of "Clerk" (a product). Decision-kind makes that mismatch impossible — the synthesizer prompt branches on the field and is told explicitly to commit to a product in concrete mode.

## API Keys

`adr-doctor setup` walks you through these interactively and persists them to `~/.adr/config.json` (mode 0600). Process env always overrides the file.

### Required (at least one of each)

| Group | Env var | Sign-up |
| --- | --- | --- |
| Search | `BRAVE_SEARCH_API_KEY` | https://api-dashboard.search.brave.com (~2k queries/month free) |
| Search | `TAVILY_API_KEY` | https://tavily.com (1k requests/month free) |
| Search | `SERPER_API_KEY` | https://serper.dev (2.5k queries on signup) |
| Search | `SEARXNG_URL` | self-hosted, https://docs.searxng.org |
| LLM | `ADR_OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| LLM | `OPENAI_API_KEY` | (fallback alias for the same key) |

If no dedicated search key is set but an OpenAI key is, ADR falls back to OpenAI's hosted `web_search` — one key powers both research and synthesis.

### Optional

- `GITHUB_TOKEN` — strongly recommended. Lifts the GitHub API limit from 60/hr to 5000/hr.
- `ADR_MODEL` — override the default model (`gpt-4.1-mini`).
- `ADR_OPENAI_BASE_URL` — point at a local OpenAI-compatible server (vLLM, LM Studio, llamafile).
- `ADR_MCP_SERVER_URL` — search a read-only private MCP corpus instead of the public web. Combine with `ADR_PRIVATE_MCP_ONLY=1` to force private-corpus search.
- `ADR_SEARCH_INCLUDE_DOMAINS` / `ADR_SEARCH_EXCLUDE_DOMAINS` — comma- or whitespace-separated domain lists to bias the evidence pool. Tavily uses them natively (`include_domains` / `exclude_domains`). Brave and Serper inject `site:` / `-site:` operators inline. Useful when an aggregator domain keeps surfacing and crowding out real engineering content. Example: `ADR_SEARCH_INCLUDE_DOMAINS=engineering.linear.app,vercel.com/blog,stripe.com/blog,danluu.com`.

### LangGraph and Google ADK runtimes

ADR's kernel is framework-neutral. Two extra runtimes are wired in via `adapters/`:

```bash
# LangGraph (full StateGraph; any LangChain-supported provider)
npm install @langchain/openai     # or @langchain/anthropic, @langchain/google-genai, ...
adr-langgraph examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" --decision "retrieval topology" \
  --out .adr-runs/langgraph --model openai:gpt-4.1-mini

# Google ADK (Gemini as the LLM backend)
export GEMINI_API_KEY=...
adr-adk examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" --decision "retrieval topology" \
  --out .adr-runs/adk
```

All three runtimes produce the same artifact set. See [docs/framework-adapters.md](./docs/framework-adapters.md).

## What ADR Produces

| Artifact | Content |
| --- | --- |
| `strategic-context.json` | Domain entities, bounded contexts, query shapes, risk invariants, operational envelope, compliance constraints extracted from the brief. |
| `research-plan.json` | LLM-planned research tasks with search queries and source targets. |
| `evidence.json` + `source-snapshots/` | Full evidence pool. Each item: URL, provider, source type, quality score, extracted claims, content hash, snapshot path. Audit-grade. |
| `knowledge-map.json` | Architecture candidates promoted (≥2 cited items, ≥1 from `official_docs` / `mature_oss` / `paper_or_benchmark` / `private_corpus`) vs `insufficient_evidence_candidates`. |
| `comparison-matrix.json` | Candidates × axes (derived from query shapes, risk invariants, operational envelope, compliance, plus any discovered anti-patterns). Each cell carries `strong` / `mixed` / `weak` / `no_evidence` + citation IDs. |
| `architecture.spec.json` | Selected topology, bounded contexts, domain invariants, rejected alternatives, required guardrails, evidence citations. |
| `critique.json` | LLM critique pass flagging uncited claims, contradictions, weak evidence. High-severity issues auto-downgrade the decision unless `--no-enforce-critique`. |
| `citation-audit.json` | Per-citation supported/unsupported verdicts. Unsupported selected-topology citations auto-downgrade. |
| `claim-audit.json` | Scans generated ADR/report/eval artifacts for material claims without citations. |
| `domain-evaluation-pack.json` | Adversarial test cases: lineage, boundary-spill, multi-hop, abstention, agentic-drift checks the implementation has to pass. |
| `execution-handoff.json` | The boundary contract: selected topology, required invariants, forbidden topologies, evaluation suite name, memory facts for the Architect bee. |
| `ADR.md`, `sources.md`, `research-report.md` | Human-readable decision record, citation table, long-form report. |

If `adr-doctor`-managed `~/.adr/config.json` is wired up and the run completes, every artifact lands in `--out`. See [examples/self-discover/](./examples/self-discover/) for a dogfooded walkthrough against this repo itself.

## Discovered Patterns Feed the Pipeline

When you run `--discover-first` (or run `adr discover` then `adr deep-research` in the same `--out`), two integrations fire automatically:

1. **Discovered anti-patterns become matrix axes.** A candidate that conflicts with `no_kafka` (cited to `docs/adr/0003.md`) lands a `weak` verdict on that axis, with the citation pointing at the team's own file.
2. **Discovered patterns flow into the evidence pool as `private_corpus` claims.** Patterns tagged with an `architecture_family` produce positive supporting claims; anti-patterns produce rejecting claims. They contribute to the promotion gate alongside live-research evidence.

The result: your team's actual history shapes what the synthesizer will consider, instead of the kernel re-deriving constraints from scratch every run.

## Superseding ADRs

When implementation evidence contradicts a prior spec, create a superseding ADR:

```bash
adr supersede .adr-runs/logistics-contract-mesh \
  --with ./new-product-context.md \
  --domain "global logistics contract analysis" --decision "retrieval topology" \
  --out .adr-runs/logistics-contract-mesh-v2 \
  --reason "Production latency contradicts the matrix verdict."
```

The new run writes `supersedes.json`, appends a supersession section to `ADR.md`, and pulls the prior decision's evidence forward.

## Web UI

```bash
npm run web:build                                    # build once
adr-web --runs .adr-runs --port 4173 --open          # serve + watch
```

Two modes, both reading kernel artifacts on disk:

- **Operator** — decision card, comparison matrix, plan, evidence panel, run-quality sidebar.
- **Developer** — live event timeline (SSE tail of `events.jsonl`), JSON inspector, per-artifact browser.

Start it **before** a run to watch the loop happen live. See [docs/web-ui.md](./docs/web-ui.md).

## Beevibe Mesh Handoff

```js
import { createBeevibeMeshHandoff } from "@beevibe/architecture-deep-research/adapters/beevibe";

const handoff = await createBeevibeMeshHandoff({
  outDir: ".adr-runs/logistics-contract-mesh"
});
```

The handoff names the Architect specialist as a normal `Agent` row, attaches memory facts for durable storage, and lists the constraints downstream coding agents must obey. See [docs/beevibe-integration.md](./docs/beevibe-integration.md).

## Why Not Just Prompt a Coding Agent?

Two reasons.

**Coding agents plan inside one session with one context window.** They cannot reason about facts that aren't in that window: current deployment topology, vendors legal flagged in March, the postmortem from last quarter's incident. A planner step does not go acquire them. A research loop does.

**Coding agents are rewarded for completion.** If you ask for an architecture, they produce one. The shape of "produce a plan" punishes saying "I do not have enough evidence." ADR's promotion gate makes refusal a first-class output.

For the longer form, see the post series:

- [Architecture Deep Research: the layer before the coding agent](https://beevibe.ai/blog/03-architecture-deep-research/)
- [Inside one ADR run: from PRD to execution handoff](https://beevibe.ai/blog/05-inside-one-adr-run/)
- [The questions that keep coming up about ADR](https://beevibe.ai/blog/04-adr-questions/)

## Verifying Your Install

```bash
npm test
```

Runs six suites locally — kernel regression, search provider, schema check, framework smoke, web smoke, MCP smoke. None of them hit the network; green here means the wiring is intact.

To exercise the live loop:

```bash
adr-doctor                       # confirm READY
adr deep-research --discover-first \
  --repo . --domain "test" --decision "retrieval topology" \
  --out .adr-runs/self-test
```

A typical run is 3–6 minutes.

## Repository Shape

```text
.
├── .claude-plugin/
│   ├── plugin.json                   Claude Code plugin manifest
│   └── marketplace.json              1-plugin marketplace (this repo doubles as one)
├── commands/
│   ├── decide.md                     /adr:decide slash command
│   ├── discover.md                   /adr:discover slash command
│   └── doctor.md                     /adr:doctor slash command
├── .mcp.json                         auto-registers the MCP server when plugin installs
├── adapters/
│   ├── beevibe.mjs                   Beevibe mesh handoff
│   ├── google-adk.mjs                ADK Agent + FunctionTool wrapper
│   ├── google-adk-deep-research.mjs  ADK as the kernel's LLM provider
│   ├── langgraph.mjs                 full StateGraph runtime
│   └── langgraph-llm.mjs             LangChain initChatModel JSON provider
├── benchmarks/
│   ├── configs/                      live-fast.json, live.json
│   └── cases/
├── docs/
│   ├── deep-research-agent.md
│   ├── framework-adapters.md
│   ├── beevibe-integration.md
│   ├── web-ui.md
│   ├── experiments.md
│   └── schemas/                      JSON Schemas for every artifact
├── examples/
│   ├── logistics-contract-mesh/      reference PRD + a real run output
│   ├── self-discover/                dogfooding walkthrough
│   └── claude-code-skill/            legacy manual-skill install
├── scripts/
│   ├── adr.mjs                       CLI (deep-research / discover / supersede)
│   ├── adr-langgraph.mjs             LangGraph CLI
│   ├── adr-adk.mjs                   Google ADK / Gemini CLI
│   ├── adr-web.mjs                   Web UI server
│   ├── adr-mcp.mjs                   MCP server (stdio)
│   ├── adr-doctor.mjs                env audit + interactive key setup
│   ├── benchmark.mjs
│   ├── kernel-regression-tests.mjs   frozen local replay checks
│   ├── check-json.mjs                schema validation across all artifacts
│   ├── smoke-frameworks.mjs          kernel + adapter smoke
│   ├── smoke-web.mjs                 web UI server smoke
│   └── smoke-mcp.mjs                 MCP server smoke
├── src/
│   ├── kernel.mjs                    the deep research kernel
│   └── discover/
│       ├── index.mjs                 discover stage orchestrator
│       ├── repo-scan.mjs             deterministic filesystem walk
│       ├── principle-extractor.mjs   LLM: scan -> patterns + anti-patterns
│       ├── constraint-extractor.mjs  LLM: scan -> stack/deploy/compliance
│       ├── prd-drafter.mjs           LLM: above -> markdown PRD draft
│       └── discovered-evidence.mjs   converts principles to private_corpus items
└── web/                              Vite + React + Tailwind UI
```

## Status

Open-source core (Apache-2.0):

- Live agentic research kernel.
- Discover stage and principle/anti-pattern integration into the comparison matrix.
- Artifact schemas validated end-to-end.
- LangGraph and Google ADK adapters.
- Claude Code plugin with MCP server + `/adr:decide`, `/adr:discover`, `/adr:doctor` commands.
- Persistent local key store via `adr-doctor`.
- Benchmark harness.

The commercial Beevibe surface can layer curated corpora, managed researcher agents, org-level memory, and team governance on top.
