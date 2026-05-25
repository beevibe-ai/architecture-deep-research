# Beevibe AI CTO
<img width="2752" height="1536" alt="image" src="https://github.com/user-attachments/assets/4f8dd109-71de-4cfa-b957-b609bf50591a" />
<img width="2752" height="1536" alt="image" src="https://github.com/user-attachments/assets/d3f2f4ce-7c00-4d21-8a7e-824e871e5138" />
<img width="1376" height="768" alt="image" src="https://github.com/user-attachments/assets/f07a64e7-563b-47a2-bba1-399215358f85" />
<img width="1376" height="768" alt="image" src="https://github.com/user-attachments/assets/12b8a8a5-850c-4e4d-81c1-12b5bd7525d9" />
<img width="1376" height="768" alt="image" src="https://github.com/user-attachments/assets/cec470bb-0411-45a1-b6e7-6029d82bcb33" />
<img width="1376" height="768" alt="image" src="https://github.com/user-attachments/assets/f9ca2f06-4ebe-48f9-96f0-852b0632b149" />
<img width="1376" height="768" alt="image" src="https://github.com/user-attachments/assets/a09f45bd-9761-441c-83dd-1eb11c29f414" />


**The decision layer your coding agents are missing.**

ADR (Architecture Deep Research) produces a research report on an architectural decision space. 

**[See an example report →](https://beevibe.ai/cto/example-report/)** A real, unedited ADR run on a Beevibe decision: 11 candidates, 60 citations, 4 Mermaid diagrams, $0.27, 122 LLM calls.

The brain + `adr guard` / `review` / `drift` close the loop; Upcoming.

---

## Install

Three ways in. All share the same kernel.

### Claude Code plugin — recommended

```bash
claude plugin marketplace add beevibe-ai/architecture-deep-research
claude plugin install adr
```

Then in any Claude Code session:

| Slash | What it does |
| --- | --- |
| `/adr:doctor` | One-time: audit env, walk through API keys, persist to `~/.adr/config.json` |
| `/adr:decide` | Ask a decision name, scan the repo, run the full pipeline, summarize the report |
| `/adr:discover` | Quick scan only — drafts a PRD without the full deep-research run |

### MCP server — Cursor, Codex, any MCP host

```bash
npm install -g github:beevibe-ai/architecture-deep-research
adr-doctor setup
```

Add to your host's MCP config:

```json
{ "mcpServers": { "adr": { "command": "adr-mcp" } } }
```

Three tools become available: `adr_discover`, `adr_deep_research`, `adr_read_handoff`.

### CLI — terminal, CI, GitHub Action

```bash
npm install -g github:beevibe-ai/architecture-deep-research
adr-doctor                       # audit env, exit non-zero if anything missing
```

## Run your first decision

```bash
adr deep-research --discover-first --include-peers --open \
  --repo . \
  --domain "your product domain" \
  --decision "vector store for agent memory" \
  --out .adr-runs/vector-store
```

What this does:

1. **Discover** scans your repo for stack signals, patterns the team follows, and antipatterns the team has explicitly rejected.
2. **Peer-finder** names 3-5 similar products. Open-source peers (Neo4j, Onyx) get read through their repos and engineering blogs. Closed-source peers (Notion, Obsidian, Mem.ai) get read through Reddit, HN, Twitter — what users actually report.
3. **Research** collects live evidence, builds a comparison matrix, runs adversarial probes against every candidate.
4. **Synthesis** writes the research report. Citation + claim audits run automatically.
5. **`--open`** renders `ADR.md` as HTML (mermaid diagrams as SVG, tables, dark/light mode) and opens it in your default browser.

A typical run takes 3-6 minutes and costs $0.10-$0.30 in API spend. Use `--dry-run` to see the plan + cost estimate without spending tokens.

## After the report

```bash
# Open the report later — or after a run that didn't use --open
adr open .adr-runs/vector-store

# Pick an option from the report and generate its implementation contract
adr handoff .adr-runs/vector-store --option pgvector

# Resume a crashed or interrupted run (reuses cached evidence.json — the expensive part)
adr resume .adr-runs/vector-store
```

The report at `<out_dir>/ADR.md` has:

- Executive Summary + Option Space table
- One section per candidate: evidence depth (`thick` / `medium` / `thin`), what the evidence shows, what it doesn't, pick-when / avoid-when reading aids, citations
- Cross-Cutting Tradeoffs across matrix axes
- Open Questions the evidence pool didn't resolve
- Where to Dig Deeper — pre-filled `adr deep-research` commands for the next iteration

The decision becomes a tree of ADR runs. Each one drills into the highest-uncertainty axis from the prior run.

## API keys

`adr-doctor setup` walks you through these interactively and stores them in `~/.adr/config.json` (mode 0600). Process env always overrides the file.

Required (at least one of each):

| Group | Env var | Free tier |
| --- | --- | --- |
| Search | `BRAVE_SEARCH_API_KEY` | ~2k queries/mo, https://api-dashboard.search.brave.com |
| Search | `TAVILY_API_KEY` | 1k requests/mo, https://tavily.com |
| Search | `SERPER_API_KEY` | 2.5k queries on signup, https://serper.dev |
| Search | `SEARXNG_URL` | self-hosted, https://docs.searxng.org |
| LLM | `ADR_OPENAI_API_KEY` (or `OPENAI_API_KEY`) | https://platform.openai.com/api-keys |

If no dedicated search key is set, ADR falls back to OpenAI's hosted `web_search` — one key powers both research and synthesis.

Optional:

- `GITHUB_TOKEN` — strongly recommended. Lifts the GitHub API limit from 60/hr to 5000/hr.
- `ADR_MODEL` — override the default model (`gpt-4.1-mini`).
- `ADR_OPENAI_BASE_URL` — point at a local OpenAI-compatible server (vLLM, LM Studio, llamafile, Ollama).
- `ADR_SEARCH_INCLUDE_DOMAINS` / `ADR_SEARCH_EXCLUDE_DOMAINS` — bias the evidence pool toward / away from specific domains.
- `ADR_MCP_SERVER_URL` + `ADR_PRIVATE_MCP_ONLY` — search a read-only private MCP corpus instead of the public web.

## What ADR produces

A run's `<out_dir>/` contains:

| File | What it is |
| --- | --- |
| `ADR.md` / `ADR.html` | Reader-facing research report (HTML is generated by `adr open`). |
| `research-report.json` | Structured report — same content, machine-readable. |
| `comparison-matrix.json` | Candidates × axes table that feeds the report. |
| `evidence.json` + `source-snapshots/` | Audit trail. Every claim cites a snapshot. |
| `peers.json` | Peers surfaced by `--include-peers`, with `evidence_strategy` per peer. Editable. |
| `decision-context.json` | Context annotations extracted from your PRD. Editable. |
| `follow-up-questions.json` | Pre-filled `adr deep-research` commands for the highest-spread axes. |
| `state.json` / `cost.json` / `events.jsonl` | Run lifecycle, cost ledger, live event log. |

After `adr handoff --option <name>`:

| File | What it is |
| --- | --- |
| `agent-guardrails.md` | Implementation contract for the chosen candidate. |
| `execution-handoff.json` | Structured handoff for downstream coding agents. |

## Verify your install

```bash
npm test
```

Six suites run locally — kernel regression, search provider, schema check, framework + web + MCP smoke. No network calls; green here means the wiring is intact.

To exercise the live loop:

```bash
adr-doctor                       # confirm READY
adr deep-research --discover-first --open \
  --repo . --domain "test" --decision "retrieval topology" \
  --out .adr-runs/self-test
```

## Status

**Shipped (the ADR flagship):**

- Live agentic research kernel — `adr decide`.
- Discover stage: stack signals, patterns, antipatterns from your own repo.
- Peer products via `--include-peers`, with `architecture` / `adoption` / `both` evidence strategies.
- Community-source class (Reddit / HN / Twitter / Stack Exchange) with relaxed citation auditing.
- Non-blocking gap detection + follow-up questions driven by matrix axis variance.
- Mermaid diagrams (decision space + per-candidate deployment topology).
- Cost transparency: `--dry-run`, `cost-estimate.json`, per-stage tally.
- Crash-aware `state.json` + `adr resume`.
- HTML report via `adr open` (mermaid as SVG, dark/light mode).
- LangGraph and Google ADK adapters (same kernel, same artifacts).
- Claude Code plugin with MCP server + `/adr:decide`, `/adr:discover`, `/adr:doctor`.
- Web UI (`adr-web`) for live operator / developer views.

**In development (the rest of the AI CTO loop):**

- **The brain** — always-on knowledge graph that watches voices, trending OSS, competitor architecture, and papers. Personalized to your stack via your PRD + past ADR runs. Visual + browsable.
- `adr guard` — Claude Code hook + pre-commit check that streams team antipatterns into the coding agent's context at write time.
- `adr review <PR#>` — PR-time check against the per-option contract + antipattern set.
- `adr drift <out_dir>` — periodic scan against the saved spec, reports drift by file:line.

Open-source core under Apache-2.0. The commercial Beevibe surface layers curated corpora, managed researcher agents, org-level memory, and team governance on top.

## Learn more

- **[See an example report](https://beevibe.ai/cto/example-report/)** — real run on a Beevibe decision, rendered the same way `adr open` would render yours.
- [ADR introduction](https://beevibe.ai/blog/03-architecture-deep-research/) — the layer before the coding agent.
- [Questions teams keep asking](https://beevibe.ai/blog/04-adr-questions/) — Q&A on the design.
- [The dogfooding journey](https://beevibe.ai/blog/06-after-dogfooding/) — what made us pivot from a decision engine to a research-report engine.
- [docs/](./docs/) — framework adapters, web UI, schemas, mesh integration, full flag reference.
