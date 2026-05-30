# Beevibe AI CTO

**The decision layer your coding agents are missing.**

<img alt="Beevibe AI CTO" src="https://github.com/user-attachments/assets/4f8dd109-71de-4cfa-b957-b609bf50591a" width="100%" />

<details>
<summary><b>More screenshots</b></summary>
<br>

<img alt="Beevibe AI CTO" src="https://github.com/user-attachments/assets/d3f2f4ce-7c00-4d21-8a7e-824e871e5138" width="100%" />
<img alt="Beevibe AI CTO" src="https://github.com/user-attachments/assets/f07a64e7-563b-47a2-bba1-399215358f85" width="100%" />
<img alt="Beevibe AI CTO" src="https://github.com/user-attachments/assets/12b8a8a5-850c-4e4d-81c1-12b5bd7525d9" width="100%" />
<img alt="Beevibe AI CTO" src="https://github.com/user-attachments/assets/cec470bb-0411-45a1-b6e7-6029d82bcb33" width="100%" />
<img alt="Beevibe AI CTO" src="https://github.com/user-attachments/assets/f9ca2f06-4ebe-48f9-96f0-852b0632b149" width="100%" />
<img alt="Beevibe AI CTO" src="https://github.com/user-attachments/assets/a09f45bd-9761-441c-83dd-1eb11c29f414" width="100%" />

</details>

The full loop, from architecture decision through PR review to drift detection:

| Command | What it does |
| --- | --- |
| `adr decide` | Live deep-research on an architectural decision → an HTML report with N candidates, citations, and Mermaid diagrams. **[See an example →](https://beevibe.ai/cto/example-report/)** |
| `adr principles init` | Scans your repo, discovers the team's code-review lenses (state-boundaries, schema-validate-before-write, etc.), walks you through an interview, writes `.adr/principles.{md,json}` |
| `adr principles refresh` | Re-discover without losing the interview log. Asks only about new ambiguities. |
| `adr principles incremental` | Only re-extract from files changed since last refresh. Reuses prior lenses. Fast. |
| `adr principles refine --id <id>` | Single-principle re-discovery for one specific rule. |
| `adr review` | Checks a PR / staged diff / branch against the principles. Walks the user through violations one-by-one, posts inline comments via `gh` / `glab` / Bitbucket API. Supports `// adr-ignore: <id>` suppression and `--batch` for one-call CI reviews. |
| `adr drift` | Full-repo scan vs principles. Useful for "how far has the codebase drifted since principles init six months ago?". |
| `adr guard install` | Wires the principles into Claude Code (PreToolUse hook surfaces them at write time) + git pre-commit (blocks high-severity violations). `adr guard uninstall` reverses it. |

The principles file evolves automatically: stale citations get flagged, accept/edit/skip stats get persisted, and confidence demotes principles users keep skipping. **No static-lint trap.** See [ROADMAP.md](./ROADMAP.md) for the evolvability story and the commit history.

The brain closes the rest of the loop; upcoming.

---

## Install

Three ways in. All share the same kernel.

### Claude Code plugin — recommended

```bash
claude plugin marketplace add beevibe-ai/beevibe-cto
claude plugin install adr
```

Then in any Claude Code session:

| Slash | What it does |
| --- | --- |
| `/adr:doctor` | One-time: audit env, walk through API keys, persist to `~/.adr/config.json` |
| `/adr:decide` | Ask a decision name, scan the repo, run the full pipeline, summarize the report |
| `/adr:discover` | Quick scan only — drafts a PRD without the full deep-research run |
| `/adr:principles` | Discover the team's code-review principles from the repo, walk through the interview conversationally |
| `/adr:review` | Check a PR / staged diff against the principles, walk through violations one at a time |
| `/adr:guard` | Install the PreToolUse + pre-commit hooks so principles fire automatically on every edit |

### MCP server — Cursor, Codex, any MCP host

```bash
npm install -g github:beevibe-ai/beevibe-cto
adr-doctor setup
```

Add to your host's MCP config:

```json
{ "mcpServers": { "adr": { "command": "adr-mcp" } } }
```

Five tools become available: `adr_discover`, `adr_deep_research`, `adr_read_handoff`, `adr_principles`, `adr_review`.

### CLI — terminal, CI, GitHub Action

```bash
npm install -g github:beevibe-ai/beevibe-cto
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

## Keep the implementation honest — principles, review, guard

Decisions don't survive contact with the codebase. The senior engineer who knows what your team standardized on becomes the only memory — repeating the same review comment to 10 different juniors, every week.

Three commands close that loop:

```bash
# Step 1: discover what the team's conventions actually are (run once per repo)
adr principles init                    # scans the repo, interviews you, writes .adr/principles.{md,json}

# Step 2: check a PR against those principles
adr review 42                          # GitHub PR
adr review --staged                    # pre-commit local
adr review --branch main               # current branch vs base

# Step 3: wire the principles into your workflow so they fire automatically
adr guard install                      # PreToolUse hook + git pre-commit
```

**`adr principles init`** uses the LLM end-to-end — no hardcoded lens taxonomy. It samples real source files from your repo, asks the model to surface the code-review angles a senior would catch (state boundaries, schema-validate-before-write, CLI patterns, test-fixture discipline, ownership routing…), extracts positive patterns + antipatterns + ambiguities with `file:line` citations, then walks you through an interactive interview to confirm. A cite-or-die filter drops any path the model invented — only principles backed by real lines on disk survive.

**`adr review`** loads the principles + a unified diff (PR / staged / branch / arbitrary diff file / stdin), groups hunks by file, runs one LLM call per file to detect violations, ranks by severity, and walks you through accept/edit/skip one at a time. Approved comments post via `gh pr review` with the team's own example cited as "follow this".

**`adr guard install`** wires two hooks:
- **Claude Code `PreToolUse`** — every Edit/Write/MultiEdit, the hook filters principles to ones relevant to the file's top-level dir (no LLM call on the hot path) and injects them into the agent's context. The agent sees the team's conventions before it generates the violation.
- **Git pre-commit** — runs `adr review --staged --top-n 5`. HIGH-severity violations block the commit; medium/low are advisory.

All three operate on the same `.adr/principles.json` artifact. Re-run `adr principles init` whenever the team's posture shifts; review and guard pick up the new rules automatically.

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

**Shipped:**

- **ADR flagship** — `adr decide`, `adr discover`, `adr open`, `adr handoff`, `adr resume`, `adr supersede`. Live agentic research kernel, peer discovery, community sources, citation + claim audits, Mermaid diagrams, HTML report, crash-aware state.
- **`adr principles`** — `init` / `refresh` / `incremental` / `refine`. LLM-discovered code-review lenses, per-lens patterns + antipatterns, interactive interview, cite-or-die filter. Cite-rot detection on every review; accept/edit/skip stats persist; confidence auto-evolves from how the team actually uses each rule.
- **`adr review`** — PR / staged / branch / file modes. Walks the user through violations one at a time, posts inline comments via `gh` (GitHub), `glab` (GitLab), or Bitbucket REST API. Supports `// adr-ignore: <principle-id>` suppression. `--batch` flag for one-call CI reviews.
- **`adr drift`** — full-repo scan vs principles, parallel-bounded. Useful for periodic "how far has the code drifted?" audits.
- **`adr guard`** — `install` / `uninstall`. Claude Code `PreToolUse` hook (write-time principle injection) + git pre-commit (blocks high-severity violations). Pure file-based filter on the hot path; idempotent.
- **Adapters + UI** — LangGraph and Google ADK (same kernel, same artifacts). Web UI (`adr-web`) for live operator / developer views.
- **Claude Code plugin** — six slash commands: `/adr:doctor`, `/adr:decide`, `/adr:discover`, `/adr:principles`, `/adr:review`, `/adr:guard`.

**In development:**

- **The brain** — always-on knowledge graph that watches voices, trending OSS, competitor architecture, and papers. Personalized to your stack via your PRD + past ADR runs + discovered principles. Markdown-in-git source of truth (Obsidian-compatible) + derived Postgres+pgvector indexes; LLM maintains the wiki, watchers ingest sources continuously.

Open-source core under Apache-2.0. The commercial Beevibe surface layers curated corpora, managed researcher agents, org-level memory, and team governance on top.

## Learn more

- **[See an example report](https://beevibe.ai/cto/example-report/)** — real run on a Beevibe decision, rendered the same way `adr open` would render yours.
- [ADR introduction](https://beevibe.ai/blog/03-beevibe-cto/) — the layer before the coding agent.
- [Questions teams keep asking](https://beevibe.ai/blog/04-adr-questions/) — Q&A on the design.
- [The dogfooding journey](https://beevibe.ai/blog/06-after-dogfooding/) — what made us pivot from a decision engine to a research-report engine.
- [docs/](./docs/) — framework adapters, web UI, schemas, mesh integration, full flag reference.
