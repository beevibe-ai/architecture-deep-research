# Beevibe AI CTO

**The decision layer your coding agents are missing.**

Architecture is the last bastion of human judgment in software, and right now it shows. Two problems compound — the decision itself, and the loop that's supposed to keep the decision honest after code lands.

### The architecture decision is broken before it's even made

- **Pre-AI guts make post-AI calls.** Engineering leads run on a gut earned in the world before agents existed. What's cheap, what's expensive, what's worth owning — all of it has shifted. A pre-AI gut making post-AI architecture is a slow drift that nobody notices until the second migration.
- **The raw material is finally accessible. Teams skip it anyway.** This is the first moment in history when reading what strong open-source projects, working papers, and architects with track records actually figured out costs minutes instead of months. We hand a one-line product brief to a coding agent and hope the model fills in the architecture from training data.
- **We have deep research for everything else.** Markets, legal, medicine, competitive teardown — all shipped years ago. Architecture, where the cost of being wrong is highest and lives in production the longest, is still done in a chat box.
- **Real AI system architect expertise is rare.** Domain expertise in AI-native architecture is genuinely hard to hire — the senior engineers candidates exist, the AI-native architect candidates barely do. Most teams default to whoever's senior, running on the pre-AI gut above.

### After the decision, the loop never closes back

- **Design-implement drift.** The architecture gets settled. Code gets written. A week later nobody knows which parts of the original spec are still true — the drift is real but unmapped.
- **AI introduces antipatterns the team already rejected.** Claude / Cursor write fast and don't know your team explicitly migrated off Kafka in 2024. The decision is in `docs/adr/0003.md`; the AI never read it.
- **Stateless PR reviews.** The team lead becomes the only living memory of the architecture. Every PR re-derives context from scratch. Review burden compounds with team growth.

Beevibe AI CTO addresses both halves. **ADR (Architecture Deep Research) — the flagship feature, fully shipped — automates the decision-time research a senior architect would do by hand.** Three additional capabilities feed back to keep the decision honest as code lands.

```text
       ┌──────────────────────────────────────────────────────────────┐
       │                                                              │
       ↓                                                              │
  ▶ decide  ────▶  ▶ guard  ────▶  ▶ review  ────▶  ▶ drift  ─────────┘
   adr decide       adr guard       adr review      adr drift
   (shipped)        (next)          (next)          (next)
```

**Flagship: Architecture Deep Research (`adr decide`).** Live, evidence-only research that produces a ranked option set with explicit tradeoffs, per-option contracts, and a citation audit. The rest of this README is the deep-dive.

**Next capabilities (in development):**
- **`adr guard`** — Claude Code hook + pre-commit check. Streams `agent-guardrails.md` + the team's `discovered-principles.json` antipatterns into the coding agent's context at write time. Blocks new code that re-introduces a rejected pattern, with a citation back to the file:line where the team rejected it.
- **`adr review <PR#>`** — PR-time check against the spec + antipattern set. Returns: *does this PR stay inside the per-option contract? does it re-introduce a discovered antipattern? which ADR.md sections are the reviewer being asked to take on faith?* Posts as a PR comment, anchored to the saved ADR run.
- **`adr drift <out_dir>`** — Periodic scan. Compares the current repo state against `architecture.spec.json` + per-option invariants from a prior ADR run. Reports drift items keyed to file:line, with three exits: update the code, auto-prep a `supersede` to update the spec, or accept the drift with explicit rationale (`drift-accepted.json`).

Together, these are the AI CTO loop: the architecture decision is settled, the coding agent honors the contract, PRs get reviewed against the contract, drift gets detected and either fixed or owned. The team lead stops being the only memory.

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

Every architecture decision is a tradeoff. ADR's primary output is a **ranked option set** — every viable candidate from the comparison matrix appears with explicit `when_to_pick` / `when_not_to_pick` conditions, `strong_axes` / `weak_axes`, and per-option `required_invariants` and `forbidden_topologies`.

A `recommendation` is added only when one option clearly dominates (strong on multiple axes that matter AND others are weak or no_evidence on at least one critical axis). When no option dominates, `mode = "ranked_options"` and the caller picks based on team-side constraints ADR cannot know (existing infrastructure, hiring plans, vendor relationships, budget envelope).

| Mode | Meaning |
| --- | --- |
| `recommended` | One option dominates; `recommendation.name` names it. The other options are recorded with their tradeoffs as alternatives. |
| `ranked_options` | Multiple options are viable with genuine tradeoffs. `recommendation: null`. Pick the option whose conditions match your situation. |
| `deferred` | No candidate cleared the promotion gate. Re-run with sharper context. |

**Commitment threshold:** when the surviving field is narrow (1 candidate, or 2 candidates where one has a 2+ lead on net strong axes), ADR commits — refusing to recommend with the field already narrowed is dishonest, not nuanced. Multi-option fields with genuine tradeoffs still land at `ranked_options`.

Coding agents downstream pick one option, then honor the matching block in `agent-guardrails.md` (per-option contract). The handoff JSON's `options[]` is the machine-readable equivalent.

## Hard Constraints

The PRD and clarification answers carry phrases like "self-hosted only", "must fit Docker Compose", "no managed services". Those are not preferences to score against — they are filters. ADR extracts them into `constraints.json` with explicit severities and uses them to eliminate candidates BEFORE the comparison matrix is built.

```json
// constraints.json (excerpt)
{
  "constraints": [
    {
      "id": "self_hosted_only",
      "statement": "Self-hosted deployment is the primary model.",
      "severity": "must_have",
      "check_question": "Does <CANDIDATE> support self-hosted deployment?",
      "evidence_from_input": "self-hosted is the primary deploy model",
      "decision_scope_relevant": true,
      "category": "deployment"
    },
    {
      "id": "supports_agent_identities",
      "statement": "Must support persistent agent identities.",
      "severity": "must_have",
      "decision_scope_relevant": false,
      "decision_scope_reason": "Application-layer requirement; no vector-store candidate can satisfy or violate this on its own."
    }
  ]
}
```

Severities + scope:

| Severity | Behavior |
| --- | --- |
| `must_have` + `decision_scope_relevant: true` | Eliminates candidates. "Self-hosted only" + Pinecone (cloud-only) → Pinecone is OUT of `ranked_options`. Eliminated candidates are recorded in ADR.md under "Eliminated by hard constraints" with the failure reason. |
| `must_have` + `decision_scope_relevant: false` | App-layer requirement that the decision layer can't satisfy on its own (e.g., "must support agent identities" for a vector-store decision). Stays in `constraints.json` for transparency, scoring inputs only — no elimination. |
| `preferred` | Scoring input. Influences ranking but does not filter. |
| `nice_to_have` | Lowest weight scoring input. |

**Safety net:** if every promoted candidate would fail the must_have set, the filter aborts (keeps the original pool) and emits `constraint_filter_aborted_empty_pool` with guidance to edit `constraints.json`. Beats crashing synthesis with an empty pool.

`constraints.json` is **editable between runs**. ADR uses the file as-is on re-invocation, so if the LLM mislabeled "ideally self-hosted" as must_have, you can change it to preferred and re-run — no full extraction needed.

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

**Concrete-mode candidate validator.** When `decision_kind: concrete`, after promotion ADR runs an extra LLM check on each candidate: `product | pattern | unsure`. Pattern-shaped names (`vector_rag`, `postgres_centric_storage`, `token_based_auth`) that leaked through from the extractor get demoted to `insufficient_evidence_candidates` with `promotion_status: "non_product_in_concrete_mode"`. The matrix only sees real products. Family mode is a no-op. Bypass with `--skip-concrete-validation`.

## Clarification Gate

ADR refuses to bluff. When the PRD lacks enough context (latency / scale / compliance / budget / region signals), the kernel writes `clarification.json` with the open questions and stops before spending tokens on a guaranteed-low-confidence run.

Three ways to unblock:

```bash
# Pass answers as free-form text or a path to a file
adr deep-research ... --clarification-answers "Self-hosted only. p95 < 500ms. 10-100 tenants. SOC2 in 12 months."

# Pick a pre-built profile (skip the questions entirely)
adr deep-research ... --clarification-profile first_paying_customers

# Force a low-confidence run (you accept the risk)
adr deep-research ... --no-clarify
```

Profiles shipped with the package:

| Profile | Fit |
| --- | --- |
| `pre_pmf_solo` | Pre-PMF, 1-3 engineers, self-hosted single-VM, budget < $50/mo. Optimizes for time-to-ship. |
| `first_paying_customers` | 3-10 engineers, 10-100 tenants, managed cloud, SOC2 in 12 months, $50-500/mo per tenant. |
| `scaling_team_post_seed` | 10-30 engineers, 100+ tenants, multi-region, SOC2 + GDPR, p95 < 200ms, $500-5k/mo per tenant. |
| `enterprise_regulated` | 30+ engineers, multi-region or on-prem, HIPAA + SOC2 + GDPR, vendor lock-in is a board concern. |

When the gate fires after a `discover` step, `clarification.json` carries a `suggested_profiles` array — the kernel matches discover signals (contributor count, codebase age, compliance) to 1-3 profiles. The slash command surfaces them as quick-pick options.

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
| `state.json` | Run lifecycle: `completed` / `crashed` / `needs_clarification` / `dry_run_complete`. On crash, includes `error` + `error_stack` so you don't have to grep `events.jsonl`. |
| `strategic-context.json` | Domain entities, bounded contexts, query shapes, risk invariants, operational envelope, compliance constraints extracted from the brief. |
| `clarification.json` | Open questions the PRD doesn't answer. Blocking gate by default. Unblocks via `--clarification-answers '<text>'`, `--clarification-profile <id>`, or `--no-clarify`. Carries `suggested_profiles` when discover signals match a built-in profile. |
| `constraints.json` | Hard constraints (`must_have` / `preferred` / `nice_to_have`) with `decision_scope_relevant` flag. Only must_haves that pass the scope check filter the candidate pool. Editable — re-runs pick up your edits. |
| `cost-estimate.json` | Written after the plan, before the expensive stages. Carries planned task count + estimated USD + per-task / per-peer coefficients. `--dry-run` short-circuits here. |
| `peers.json` *(opt-in via `--include-peers`)* | 3-5 similar / competitor products with their GitHub URLs and momentum signal. The deep-research planner adds one targeted task per peer for the specific decision aspect. |
| `discovered-principles.json` + `discovered-constraints.json` *(when `discover` ran)* | Patterns + antipatterns + stack signals from the user's own repo. Patterns flow into the evidence pool as `private_corpus` claims. The stack signals drive a `fits_existing_stack` matrix axis. |
| `research-plan.json` | LLM-planned research tasks with search queries and source targets. Includes peer-targeted tasks when `peers.json` is present. Placeholder queries (`<product name>`) get filtered out at parse time. |
| `evidence.json` + `source-snapshots/` | Full evidence pool. Each item: URL, provider, source type, quality score, extracted claims (each with a literal `quote` from the excerpt), content hash, snapshot path. Audit-grade. Reused by `adr resume`. |
| `knowledge-map.json` | Architecture candidates promoted (≥2 cited items, ≥1 from `official_docs` / `mature_oss` / `paper_or_benchmark` / `private_corpus`) vs `insufficient_evidence_candidates`. Eliminated candidates carry the reason: `eliminated_by_hard_constraint`, `non_product_in_concrete_mode`, or `off_topic_for_decision`. |
| `comparison-matrix.json` | Candidates × axes. Axes are derived from query shapes (every shape becomes an axis), risk invariants (every invariant becomes an axis), operational envelope, compliance, plus `fits_existing_stack` when discover surfaced a stack, plus team-antipattern axes. Each cell carries `strong` / `mixed` / `weak` / `no_evidence`, citation IDs, and a quantitative summary (numbers verbatim from the source when available). |
| `architecture.spec.json` | `decision.mode` (`recommended` / `ranked_options` / `deferred`), `decision.ranked_options[]` (every viable option with `when_to_pick`, `when_not_to_pick`, `strong_axes`, `weak_axes`, per-option `required_invariants` and `forbidden_topologies`), `decision.recommendation` (when one option dominates). Schema failures fall back to `architecture.spec.invalid.json` + `architecture.spec.validation-errors.txt` so downstream artifacts still write. |
| `architecture.spec.v1.json` / `critique.v1.json` *(when resynth fired)* | Original pre-resynthesis spec + its critique, kept for transparency. |
| `critique.json` | LLM critique pass — evaluates option-set quality (duplicate options, ungrounded `strong_axes`, citation bleed, unsupported recommendation, missing options). High-severity issues drop the recommendation (option set survives) unless `--no-enforce-critique`. |
| `citation-audit.json` | Per-citation supported/unsupported verdicts, batched by claim_context. Unsupported recommendation citations drop the recommendation. |
| `claim-audit.json` | Scans generated ADR/report/eval artifacts for material claims without citations. |
| `domain-evaluation-pack.json` | Option-aware adversarial test cases: per-option behavior tests (tenant isolation, MFA flow, lineage depth, latency-at-load), keyed on each option's `strong_axes`. Caller runs these against the implementation. |
| `ADR.md` | Reader-facing markdown. Leads with the tradeoffs across options, then the recommendation (if any), then per-option `Pick this when` / `Avoid when`. Includes `## Eliminated by hard constraints`, `## Evidence from your repo` (private_corpus items), and `## References` (every citation_id → URL + title + source_type). |
| `agent-guardrails.md` | Per-option contract blocks. A coding agent implementing option A applies A's invariants and forbidden_topologies — not B's. |
| `execution-handoff.json` | Per-option contracts in `options[]` plus `recommendation` and `validation_warnings` when any artifact failed schema. |
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
- Hard constraints with decision-scope-relevance + commitment threshold.
- Concrete-mode candidate validation; relevance filter; quantitative cell content.
- Peer-product research via `--include-peers`.
- Clarification gate with pre-built profiles.
- Cost transparency (`--dry-run`, `cost-estimate.json`, per-stage tally).
- Crash-aware `state.json` + `adr resume <out_dir>`.
- Artifact schemas validated end-to-end.
- LangGraph and Google ADK adapters.
- Claude Code plugin with MCP server + `/adr:decide`, `/adr:discover`, `/adr:doctor` commands.
- Persistent local key store via `adr-doctor`.
- Benchmark harness.

**In development (the rest of the AI CTO loop):**
- `adr drift <out_dir>` — periodic scan, compares current repo state against the saved spec, reports drift by file:line.
- `adr review <PR#>` — PR-time check against the per-option contract + antipattern set.
- `adr guard` — Claude Code hook + pre-commit check that streams team antipatterns into the coding agent's context at write time.

The repo URL remains `beevibe-ai/architecture-deep-research` — that's where Beevibe AI CTO ships from. The product name is "Beevibe AI CTO"; ADR is the flagship feature; the upcoming three commands close the loop.

The commercial Beevibe surface can layer curated corpora, managed researcher agents, org-level memory, and team governance on top.
