# Beevibe AI CTO

**The decision layer your coding agents are missing.**

Architecture is the last bastion of human judgment in software, and right now it shows. Two problems compound — the decision itself, and the loop that's supposed to keep the decision honest after code lands.

### The architecture decision is broken before it's even made

- **Pre-AI guts make post-AI calls.** Engineering leads run on a gut earned in the world before agents existed. What's cheap, what's expensive, what's worth owning — all of it has shifted. A pre-AI gut making post-AI architecture is a slow drift that nobody notices until the second migration.
- **The raw material is finally accessible. Teams skip it anyway.** This is the first moment in history when reading what strong open-source projects, working papers, and architects with track records actually figured out costs minutes instead of months. We hand a one-line product brief to a coding agent and hope the model fills in the architecture from training data.
- **We have deep research for everything else.** Markets, legal, medicine, competitive teardown — all shipped years ago. Architecture, where the cost of being wrong is highest and lives in production the longest, is still done in a chat box.
- **Real AI system architect expertise is rare.** Domain expertise in AI-native architecture is genuinely hard to hire — the senior engineers candidates exist, the AI-native architect candidates barely do. Most teams default to whoever's senior, running on the pre-AI gut above.

### After the decision, the loop never closes back

- **AI agents rebuild the wheel and neglect existing decisions.** When the architecture lives in someone's head or in `docs/adr/`, agents re-derive solutions from scratch — they don't read your team's existing patterns, don't know you already migrated off Kafka, don't know you already standardized on pgvector. Infrastructure gets duplicated; antipatterns sneak in.
- **Design-implement drift.** The architecture gets settled. Code gets written. A week later nobody knows which parts of the original spec are still true — the drift is real but unmapped.
- **Education + PR review don't scale to AI-coding speed.** Teams onboard to DDD / clean architecture / SOLID in learning series that cost weeks of senior time. Then every PR still takes 1+ hour of review for 10+ violations — because AI agents don't sit in the learning series, new hires keep arriving, and the patterns slip even for the people who attended. The team lead becomes both educator and enforcer, and that workload scales linearly with team size.

Beevibe AI CTO addresses both halves. **ADR (Architecture Deep Research) — the flagship feature, fully shipped — automates the decision-time research a senior architect would do by hand.** A continuously-evolving brain feeds it, and three additional capabilities feed back to keep the decision honest as code lands.

```text
   ┌──────────── BRAIN (always-on knowledge graph) ────────────┐
   │   voices · trending OSS · competitor architecture · papers │
   └────────────────────────────┬───────────────────────────────┘
                                │ feeds
       ┌────────────────────────┼─────────────────────────────────────┐
       │                        ↓                                     │
       ↓                                                              │
  ▶ decide  ────▶  ▶ guard  ────▶  ▶ review  ────▶  ▶ drift  ─────────┘
   adr decide       adr guard       adr review      adr drift
   (shipped)        (next)          (next)          (next)
```

**Flagship: Architecture Deep Research (`adr decide`).** Live, evidence-only research that produces a ranked option set with explicit tradeoffs, per-option contracts, and a citation audit. The rest of this README is the deep-dive.

**Next capabilities (in development):**
- **The brain** — always-on knowledge graph. Continuously watches what the world ships today: the engineers with track records (Linear, Stripe, Notion, Vercel) on Twitter / HN / talks; trending OSS in your space (filtered for staying power, not flash-in-the-pan stars); competitors' architecture — public repos + ARCHITECTURE.md + engineering posts, not their landing pages; papers becoming engineering reality (arXiv / USENIX / ACM filtered through "what's actually being implemented"). Personalized to your stack via your PRD + past ADR runs. Catches the academic → engineering crossover before competitors do. Visual + browsable like Obsidian. Feeds all four loop stages.
- **`adr guard`** — Claude Code hook + pre-commit check. Streams `agent-guardrails.md` + the team's `discovered-principles.json` antipatterns into the coding agent's context at write time. Blocks new code that re-introduces a rejected pattern, with a citation back to the file:line where the team rejected it.
- **`adr review <PR#>`** — PR-time check against the spec + antipattern set. Returns: *does this PR stay inside the per-option contract? does it re-introduce a discovered antipattern? which ADR.md sections are the reviewer being asked to take on faith?* Posts as a PR comment, anchored to the saved ADR run.
- **`adr drift <out_dir>`** — Periodic scan. Compares the current repo state against `architecture.spec.json` + per-option invariants from a prior ADR run. Reports drift items keyed to file:line, with three exits: update the code, auto-prep a `supersede` to update the spec, or accept the drift with explicit rationale (`drift-accepted.json`).

Together, these are the AI CTO loop: the brain stays current with the field, the architecture decision is settled with that current evidence, the coding agent honors the contract, PRs get reviewed against the contract, drift gets detected and either fixed or owned. The team lead stops being the only memory.

---

## Architecture Deep Research (ADR) — the flagship

ADR answers the question coding agents still handle badly:

> Given this product, domain, data shape, compliance envelope, team maturity, and operating budget — which architecture family should we bet on before a coding agent writes the first file?

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
- ADR produces a **ranked option set with explicit tradeoffs**, not a single forced winner. Every run maps the option space — even when only one candidate survives the promotion gate, that just means "we found one option in this space," not "this is the answer." The caller picks based on team-side constraints ADR cannot know. When no candidate clears the gate at all, the mode is `deferred` — re-run with sharper context.

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

# Budget sanity-check before a real run — prints plan + estimated cost, exits
adr deep-research --discover-first --dry-run \
  --repo . --domain "internal-tools" --decision "event bus topology" \
  --out .adr-runs/event-bus

# Resume a crashed or interrupted run — reuses evidence.json from the prior
# run (the expensive part) and re-runs synthesis + audits + handoff
adr resume .adr-runs/event-bus

# Or two-step: scan, edit the draft, then run
adr discover --repo . --decision "event bus topology" --out .adr-runs/discover
$EDITOR .adr-runs/discover/pdr.draft.md     # fill in the Open questions
adr deep-research .adr-runs/discover/pdr.draft.md \
  --domain "internal-tools" --decision "event bus topology" \
  --out .adr-runs/event-bus-deep
```

> `npm install -g github:...` installs straight from this GitHub repo — no npm registry account required. A published `@beevibe/architecture-deep-research` package on npmjs.com may follow.

## Ranked Options, Not a Single Forced Winner

Every architecture decision is a tradeoff. ADR's job is to **map the option space** — every viable candidate from the comparison matrix appears with explicit `when_to_pick` / `when_not_to_pick` conditions, `strong_axes` / `weak_axes`, and per-option `required_invariants` and `forbidden_topologies`. The caller picks based on team-side constraints ADR cannot know (existing infrastructure, hiring plans, vendor relationships, budget envelope).

| Mode | Meaning |
| --- | --- |
| `ranked_options` | The option space is mapped. Every viable candidate appears in `ranked_options[]` with its tradeoffs. Pick the option whose conditions match your situation. `recommendation` is always `null`. |
| `deferred` | No candidate cleared the promotion gate. Re-run with sharper context. |

A run that returns one viable option lands in `ranked_options` with `ranked_options[].length === 1`. That means "we found one option in this space," not "this is the answer" — the reader is still the one picking. The follow-up questions section (see below) is how ADR widens the search if one option feels too thin.

Coding agents downstream pick one option, then honor the matching block in `agent-guardrails.md` (per-option contract). The handoff JSON's `options[]` is the machine-readable equivalent.

## Decision Context (Annotations, Not Filters)

The PRD and clarification answers carry phrases like "self-hosted only", "p95 < 500ms", "SOC2 in 12 months". ADR extracts these into `decision-context.json` as **annotations on the option space** — they show up in the report header and flow to synthesis as soft context. They do NOT eliminate candidates.

The user applies their own constraints by reading the matrix. A "self-hosted only" annotation does not drop Pinecone from `ranked_options`; the reader sees Pinecone's deployment row marked `cloud only` and rules it out themselves. This is intentional — filtering candidates inside ADR is the failure mode where a mislabeled "ideally self-hosted" annotation silently drops the option the user would actually have picked.

```json
// decision-context.json (excerpt)
{
  "version": "1.0",
  "decision": "vector store",
  "domain": "agent-native OS",
  "tags": ["phase:pre_pmf", "deployment:self_hosted", "cost_sensitivity:high"],
  "notes": [
    {
      "id": "self_hosted_primary",
      "category": "deployment",
      "statement": "Self-hosted deployment is the primary model.",
      "evidence_from_input": "self-hosted is the primary deploy model"
    },
    {
      "id": "fits_docker_compose",
      "category": "deployment",
      "statement": "Should fit the existing Docker Compose stack.",
      "evidence_from_input": "fits the existing Docker Compose"
    }
  ]
}
```

`notes` are LLM-extracted from the PRD. `tags` come from a pre-built profile when one was selected (see [Profiles](#profiles-tags-not-constraints) below). Both are shown in the ADR.md report header so reviewers see what the user said about their situation.

`decision-context.json` is **editable between runs**. ADR uses the file as-is on re-invocation, so you can refine the notes or strip irrelevant tags and re-run — no full extraction needed.

## Peer Products (Similar / Competitor Research)

Real users picking architectures don't reason in the abstract — they look at 3-5 already-shipped similar products and ask "what did they do, and does it apply to us?" ADR can do that automatically via `--include-peers`.

```bash
adr deep-research --discover-first --include-peers \
  --domain "agent-native OS" --decision "vector store" \
  --out .adr-runs/beevibe-vectors
```

What happens:

1. **Discover names 3-5 peers** in the same product space (with their GitHub URLs when open-source). LLM-named, then ranked by stars + recency. Dead repos (no commits in 18 months) are dropped. Closed-source peers survive (researched via their docs/blog).
2. **Deep-research adds one targeted task per peer** — *"how does Linear handle `<decision>`?"* — hitting the peer's GitHub repo, ARCHITECTURE.md, docs, and engineering blog.
3. **Peer findings flow into the evidence pool** as regular citations. A peer using pgvector becomes evidence backing pgvector. The comparison matrix and synthesis treat peer evidence like any other source.

Useful when you want concrete grounding ("WorkOS, Cal.com, and Onyx all use Postgres for tenancy") instead of abstract comparisons. The peer list is written to `peers.json` — you can edit it between runs to add/remove products. CLI knobs: `--include-peers`, `--max-peers <N>` (default 5), `--seed <name>` (anchor peer-finding to a specific seed).

### Architecture vs adoption strategies

Not every peer is read the same way. Each peer in `peers.json` carries an `evidence_strategy` field:

| Strategy | Used for | Where ADR looks |
| --- | --- | --- |
| `architecture` | Open-source peers with public source code, ARCHITECTURE.md, or engineering blogs (Neo4j, Memgraph, Onyx, Cal.com). | GitHub repo internals, docs, engineering posts. The existing query templates. |
| `adoption` | Closed-source or lightly-documented peers that nonetheless carry strong adoption signal (Obsidian, Roam, Mem.ai, Notion). | Community channels — Reddit, Hacker News, Twitter/X, migration write-ups. A dedicated `adoption_research_planner` LLM picks the queries. |
| `both` | Open-source peers where community signal also matters (the architecture set wins ties when the merged query budget caps at 5). | Both query sets. |

Adoption-strategy peers exist because architecture posts can't tell you whether r/LocalLLaMA practitioners actually like a tool, what migration regrets show up on HN, or which plugin ecosystem has lock-in. Community sources from reddit.com, news.ycombinator.com, twitter.com / x.com, stackoverflow.com, and the Stack Exchange network get tagged `source_type: community_discussion` and carry a `platform` field (with `subreddit` for Reddit, `story_id` for HN where available).

Community-source claims are framed as **practitioner signal, not architectural fact**. The synthesis prompt phrases them like "r/LocalLLaMA practitioners report X" rather than treating them as authoritative. The citation auditor relaxes its literal-substring rule for these sources (≥60% significant-token overlap instead of an exact quote), because community posts paraphrase. When the evidence pool contains at least one `community_discussion` source, three adoption-flavored axes are added to the comparison matrix: `ecosystem_traction`, `integration_breadth`, `practitioner_pain_points`. Pure-architecture runs are unaffected.

## Follow-up Questions (Non-Blocking)

ADR does not refuse to run on thin context. Gap detection still runs at the start — if the PRD lacks latency / scale / compliance / budget / region signals, the kernel emits `decision_context_gaps_detected` with the open questions — but the run **continues**. Burning the evidence budget on a thin PRD beats forcing the user to answer a clarification dialog before they've seen anything.

After synthesis, ADR inspects the comparison matrix's axis variance and proposes **follow-up questions** — each one a sharper sub-decision targeting the highest-spread axis. They're written to `follow-up-questions.json` and appended to `ADR.md` under `## Follow-up Questions`. Each question carries a pre-filled `adr deep-research` command the user can paste.

```json
// follow-up-questions.json (excerpt)
{
  "version": "1.0",
  "decision": "vector store",
  "follow_ups": [
    {
      "axis": "deployment_model",
      "spread_score": 0.84,
      "question": "Self-hosted or managed? The matrix splits cleanly on this axis — pgvector + Weaviate self-host; Pinecone is cloud-only.",
      "suggested_command": "adr deep-research --discover-first --repo . --domain \"agent-native OS\" --decision \"self-hosted vector store\" --out .adr-runs/vector-store-self-hosted"
    }
  ]
}
```

The decision becomes a **tree of ADR runs**, each one drilling into the highest-uncertainty axis from the prior run. First run maps the space; the follow-up questions tell you where the space is widest; the next run goes narrower on that axis with sharper inputs.

### Profiles (Tags, Not Constraints)

Profiles attach a flat tag array (stage, team size, deployment shape, cost sensitivity) to a run so the report header carries the user's situation without an extra dialog. Tags are shown alongside the option space and passed to synthesis as soft annotations. **They do not filter candidates** — a `deployment:self_hosted_single_vm` tag does not eliminate Pinecone; the matrix shows you Pinecone's deployment row and you rule it out yourself.

Profiles shipped with the package (in [`src/clarification-profiles.mjs`](src/clarification-profiles.mjs)):

| Profile | Tags |
| --- | --- |
| `pre_pmf_solo` | `phase:pre_pmf`, `team:1-3`, `deployment:self_hosted_single_vm`, `cost_sensitivity:high` |
| `first_paying_customers` | `phase:early_paying`, `team:3-10`, `deployment:managed_cloud`, `compliance:soc2_in_progress`, `cost_sensitivity:medium` |
| `scaling_team_post_seed` | `phase:post_seed`, `team:10-30`, `deployment:multi_region`, `compliance:soc2+gdpr`, `latency:p95_under_200ms`, `cost_sensitivity:low` |
| `enterprise_regulated` | `phase:enterprise`, `team:30+`, `deployment:multi_region_or_on_prem`, `compliance:hipaa+soc2+gdpr`, `cost_sensitivity:control_dominates` |

The module exports `PROFILES`, `suggestProfiles({ discovered signals })`, `profileById(id)`, and `profileTagsAsText(profile)`. A `--profile` CLI flag wiring these into the run is a follow-up — today, copy the tag text into your PRD before running.

## Cost Transparency

Every ADR run carries real per-invocation cost (web search API calls + LLM tokens). The kernel makes those visible.

```bash
# Print plan + cost estimate, don't spend tokens
adr deep-research --dry-run --discover-first \
  --repo . --domain "..." --decision "..." --out .adr-runs/X

# Output (excerpt):
#   Dry run: 8 tasks planned (5 peer-targeted).
#   Estimated cost: ~$0.1247 (rough, ±30%).
#   Plan written to .adr-runs/X/research-plan.json.
```

Artifacts:

- `cost-estimate.json` — written after the plan, before any expensive stage. Carries planned task count + estimated USD + profile (per-task / per-peer / per-adversarial coefficients).
- `cost-progress` events — fire after research_completed + synthesis_completed with running total.
- `cost.json` — final ledger. Per-LLM-label call counts, token counts (input / output / cached), per-phase USD estimate, run total.

Estimates are rough (±30%) — actual cost varies with PRD size, source page length, and how many cycles the adaptive / adversarial loops trigger. Good enough for budget sanity checks.

## Resume After a Crash

Evidence collection is the expensive part of a run (60-80% of LLM calls). When the kernel crashes mid-pipeline — or you want to retry with a code-side fix — `adr resume` reuses the existing `evidence.json` and re-runs only synthesis + audits + handoff.

```bash
adr resume .adr-runs/event-bus
```

What happens:

1. Reads `run-config.json` (written at the start of every run with the original flags + input path) to reconstruct the invocation.
2. Re-runs `prepareRun` (constraint extraction is file-cached, so this is cheap).
3. `executeResearchPhase` detects `evidence.json` from the prior run, loads it, and skips the research loop. Emits `research_resumed_from_cache`.
4. All downstream stages (matrix, synthesis, critique, audits, handoff) re-run normally — cheap relative to research, and picks up any kernel-side fixes since the prior run.
5. Appends to the same `events.jsonl` so the run history is continuous.

Cost: typically a third to a fifth of the original run.

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
- `ADR_CACHE_DIR` / `ADR_CACHE_TTL_DAYS` / `ADR_CACHE_DISABLE` — cross-run page cache. Default location is `~/.adr/cache/`; default TTL is 7 days. The cache keys on the bare URL (fragment stripped) so iterative re-runs with sharper questions don't re-download HTML they already have. Set `ADR_CACHE_DISABLE=1` to bypass entirely.

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
| `run-config.json` | The original flags + input path the run was invoked with. Used by `adr resume <out_dir>` to replay. |
| `state.json` | Run lifecycle: `completed` / `crashed` / `dry_run_complete`. On crash, includes `error` + `error_stack` so you don't have to grep `events.jsonl`. |
| `strategic-context.json` | Domain entities, bounded contexts, query shapes, risk invariants, operational envelope, compliance constraints extracted from the brief. |
| `decision-context.json` | Context notes + profile tags extracted from the PRD and clarification answers. **Annotations on the option space, not filters.** Shown in the report header and passed to synthesis as soft context. Editable — re-runs pick up your edits. |
| `follow-up-questions.json` | Sharper sub-decision questions derived from comparison-matrix axis variance. Each carries the axis, the variance score, the question, and a pre-filled `adr deep-research` command. Also appended to `ADR.md` under "## Follow-up Questions". |
| `cost-estimate.json` | Written after the plan, before the expensive stages. Carries planned task count + estimated USD + per-task / per-peer coefficients. `--dry-run` short-circuits here. |
| `peers.json` *(opt-in via `--include-peers`)* | 3-5 similar / competitor products with their GitHub URLs and momentum signal. The deep-research planner adds one targeted task per peer for the specific decision aspect. |
| `discovered-principles.json` + `discovered-constraints.json` *(when `discover` ran)* | Patterns + antipatterns + stack signals from the user's own repo. Patterns flow into the evidence pool as `private_corpus` claims. The stack signals drive a `fits_existing_stack` matrix axis. |
| `research-plan.json` | LLM-planned research tasks with search queries and source targets. Includes peer-targeted tasks when `peers.json` is present. Placeholder queries (`<product name>`) get filtered out at parse time. |
| `evidence.json` + `source-snapshots/` | Full evidence pool. Each item: URL, provider, source type, quality score, extracted claims (each with a literal `quote` from the excerpt), content hash, snapshot path. Audit-grade. Reused by `adr resume`. |
| `knowledge-map.json` | Architecture candidates promoted (≥2 cited items, ≥1 from `official_docs` / `mature_oss` / `paper_or_benchmark` / `private_corpus`) vs `insufficient_evidence_candidates`. Eliminated candidates carry the reason: `off_topic_for_decision` is the typical one. |
| `comparison-matrix.json` | Candidates × axes. Axes are derived from query shapes (every shape becomes an axis), risk invariants (every invariant becomes an axis), operational envelope, compliance, plus `fits_existing_stack` when discover surfaced a stack, plus team-antipattern axes. When the evidence pool contains at least one `community_discussion` source, three adoption axes are added: `ecosystem_traction`, `integration_breadth`, `practitioner_pain_points`. Each cell carries `strong` / `mixed` / `weak` / `no_evidence`, citation IDs, and a quantitative summary (numbers verbatim from the source when available). |
| `architecture.spec.json` | `decision.mode` (`ranked_options` or `deferred`), `decision.ranked_options[]` (every viable option with `when_to_pick`, `when_not_to_pick`, `strong_axes`, `weak_axes`, per-option `required_invariants` and `forbidden_topologies`). `recommendation` is always `null` — the reader picks from the ranked tradeoffs. Schema failures fall back to `architecture.spec.invalid.json` + `architecture.spec.validation-errors.txt` so downstream artifacts still write. |
| `architecture.spec.v1.json` / `critique.v1.json` *(when resynth fired)* | Original pre-resynthesis spec + its critique, kept for transparency. |
| `critique.json` | LLM critique pass — evaluates option-set quality (duplicate options, ungrounded `strong_axes`, citation bleed, unsupported recommendation, missing options). High-severity issues drop the recommendation (option set survives) unless `--no-enforce-critique`. |
| `citation-audit.json` | Per-citation supported/unsupported verdicts, batched by claim_context. Unsupported recommendation citations drop the recommendation. |
| `claim-audit.json` | Scans generated ADR/report/eval artifacts for material claims without citations. |
| `domain-evaluation-pack.json` | Option-aware adversarial test cases: per-option behavior tests (tenant isolation, MFA flow, lineage depth, latency-at-load), keyed on each option's `strong_axes`. Caller runs these against the implementation. |
| `ADR.md` | Reader-facing markdown. Leads with the decision-context header (tags + notes), then the tradeoffs across options, then per-option `Pick this when` / `Avoid when`. Includes `## Evidence from your repo` (private_corpus items), `## Follow-up Questions` (sharper sub-decisions for the next run), and `## References` (every citation_id → URL + title + source_type). |
| `agent-guardrails.md` | Per-option contract blocks. A coding agent implementing option A applies A's invariants and forbidden_topologies — not B's. |
| `execution-handoff.json` | Per-option contracts in `options[]` plus `validation_warnings` when any artifact failed schema. `recommendation` is always `null` — pick an option from the matrix. |
| `events.jsonl` | Live research log. Every event carries concrete content: page previews, claim quotes, per-option summaries, eliminated-candidate reasons, running cost tally. Stream via `tail -F` for a chat surface. |
| `cost.json` | Final ledger: per-LLM-label call counts, token counts (input / output / cached), per-phase USD estimate, run total. |
| `sources.md`, `research-report.md` | Citation table, long-form report. |

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

**Shipped (the ADR flagship):**
- Live agentic research kernel — decide stage.
- Discover stage and principle/anti-pattern integration into the comparison matrix.
- Decision context as annotations (not filters); profile tags carried through to synthesis.
- Relevance filter; quantitative cell content.
- Peer-product research via `--include-peers`, with `evidence_strategy` (architecture / adoption / both) per peer.
- `community_discussion` source class for Reddit / HN / Twitter / Stack Exchange, with relaxed citation auditing and conditional adoption axes.
- Non-blocking gap detection + post-run follow-up question proposal driven by matrix axis variance.
- Cost transparency (`--dry-run`, `cost-estimate.json`, per-stage tally).
- Crash-aware `state.json` + `adr resume <out_dir>`.
- Artifact schemas validated end-to-end.
- LangGraph and Google ADK adapters.
- Claude Code plugin with MCP server + `/adr:decide`, `/adr:discover`, `/adr:doctor` commands.
- Persistent local key store via `adr-doctor`.
- Benchmark harness.

**In development (the rest of the AI CTO loop):**
- **The brain** — always-on knowledge graph that watches voices, trending OSS, competitor architecture, and papers. Personalized to your stack. Feeds all four loop stages. Visual + browsable.
- `adr drift <out_dir>` — periodic scan, compares current repo state against the saved spec, reports drift by file:line.
- `adr review <PR#>` — PR-time check against the per-option contract + antipattern set.
- `adr guard` — Claude Code hook + pre-commit check that streams team antipatterns into the coding agent's context at write time.

The repo URL remains `beevibe-ai/architecture-deep-research` — that's where Beevibe AI CTO ships from. The product name is "Beevibe AI CTO"; ADR is the flagship feature; the brain + the upcoming three commands close the loop.

The commercial Beevibe surface can layer curated corpora, managed researcher agents, org-level memory, and team governance on top.
