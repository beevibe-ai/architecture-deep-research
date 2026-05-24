---
description: Run a full Architecture Deep Research pipeline against the current repo and a named decision. Scans the repo for patterns and anti-patterns, drafts a PRD, runs live deep-research with citation audits, and returns a decision handoff the coding agent can implement under.
---

# /adr:decide — Architecture Deep Research

Use when the user is making an architecture decision and wants ADR to run the full pipeline. Trigger phrases: "pick a topology", "should we use Kafka or Postgres LISTEN", "what retrieval architecture", "decide auth provider", "architecture deep research".

The run takes 3–6 minutes. **You MUST stream progress to the user as events land — silent waiting is bad UX.** This command uses background bash + `tail -F` + the `Monitor` tool to surface each event in chat as it happens, instead of blocking on the MCP tool until completion.

## Step 1 — Confirm the decision name

Ask **one** question (skip if the user already named it):

> What's the architecture decision? (e.g. "event bus topology", "retrieval architecture", "auth provider")

Capture as `<DECISION>`. Derive `<SLUG>` by lowercasing and replacing non-alphanum with `-`. Derive `<DOMAIN>` from the repo's README / package.json — if you can't tell, ask.

ADR produces a research report on the decision space — whatever candidates the live evidence surfaces (architecture patterns, specific products, or a mix) get their own section in `research-report.json` and `ADR.md`. The reader decides.

## Step 1.5 — Ask whether to include peer products

Most architects looking at a real decision want to see 3-5 similar products and how they handle the same aspect ("what does Linear use for vector storage?" beats reading abstract benchmarks). Ask:

> Question: "Should ADR also research 3-5 similar / competitor products and how each one handles `<DECISION>`?"
>
> Options:
> - **Yes — include peers (recommended)** — Discover finds 3-5 comparable products. Deep-research adds one targeted task per peer hitting their GitHub repo, docs, and engineering blog for this specific decision aspect. Adds 30-60s + a few cents to the run.
> - **No — skip peers** — Standard pipeline only.

Capture as `<INCLUDE_PEERS>` (boolean). If yes, you'll pass `--include-peers` on the deep-research invocation below.

## Step 2 — Confirm the env is ready

```bash
npx -y --package=github:beevibe-ai/architecture-deep-research adr-doctor
```

If NOT READY, invoke `/adr:doctor` and wait. Do not proceed with a broken env.

## Step 3 — Prepare the output dir and event log

The deep-research command writes `events.jsonl` to `--out`. We pre-create it so `tail -F` can attach before the file would otherwise exist.

```bash
mkdir -p .adr-runs/<SLUG>
touch .adr-runs/<SLUG>/events.jsonl
```

## Step 4 — Kick off deep-research in the background

Use the Bash tool with `run_in_background: true`. **Capture the returned task id** — you'll need it to know when the run finishes.

```bash
npx -y --package=github:beevibe-ai/architecture-deep-research adr \
  deep-research --discover-first \
  --repo . \
  --domain "<DOMAIN>" \
  --decision "<DECISION>" \
  --out .adr-runs/<SLUG>
```

When `<INCLUDE_PEERS>` is true, append `--include-peers` to the command (and optionally `--max-peers <N>` if the user asked for a different cap, default is 5).

Tell the user something like: *"Kicked off — typical run is 3–6 minutes. I'll surface each stage as it happens."*

## Step 5 — Tail the event log in the background

Second Bash call, also `run_in_background: true`. **Capture this task id too** so you can stop the tail when the deep-research finishes.

```bash
tail -F .adr-runs/<SLUG>/events.jsonl
```

Each line that lands is a JSON object: `{"ts":"...","type":"<event_type>", ...extra_fields}`.

## Step 6 — Stream events to the user via Monitor

Use the `Monitor` tool on the `tail -F` task id. Each new stdout line is a notification with one event. **Render every event** — most as a single line, some as a multi-line content block when the payload carries concrete content the user should see (URLs, claims, options, eliminated candidates, etc.). The point is for the chat to be a live research log, not a progress bar.

### Single-line events (one chat line each)

| event_type | One-line message |
| --- | --- |
| `repo_scanned` | ✓  Repo scan done — `file_count` files, `manifest_count` manifests, `deploy_config_count` deploy configs |
| `principles_extracted` | ✓  Discovered `pattern_count` patterns + `antipattern_count` anti-patterns |
| `pdr_drafted` | ✓  Drafted PRD — `bytes` bytes |
| `peers_extraction_failed` | ⚠  Peer finder failed — proceeding without peers |
| `discover_completed` | ✓  Discover stage complete |
| `run_started` | 🚀  Deep-research started — `<domain>`: `<decision>` |
| `strategic_context_created` | ✓  Strategic context: `query_shapes.length` entities, `bounded_contexts.length` query shapes |
| `decision_context_loaded_from_disk` | ✓  Decision context loaded from existing `decision-context.json` (`note_count` notes) |
| `decision_context_extraction_failed` | ⚠  Decision context extraction failed — proceeding without annotations |
| `research_plan_created` | 🌐  Planned `task_count` research tasks (`peer_task_count` peer-targeted) |
| `research_batch_started` | 🔎  Dispatching parallel research agents (max `max_parallel`) |
| `research_agent_started` | &nbsp;&nbsp;🔍  task: `<title>` |
| `research_round_started` | &nbsp;&nbsp;&nbsp;&nbsp;round `round` searching: `queries[0]` |
| `research_search_completed` | &nbsp;&nbsp;&nbsp;&nbsp;round `round` got `result_count` hits for `query` |
| `research_source_skipped` | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;↪ skipped `<title>` (`reason`) |
| `research_round_judged` | &nbsp;&nbsp;&nbsp;&nbsp;round `round` judge: complete=`<value>` |
| `research_round_completed` | &nbsp;&nbsp;&nbsp;&nbsp;round `round` ✓ (`evidence_count` evidence) |
| `research_agent_finished` | &nbsp;&nbsp;✓  task done (`evidence_count` evidence) |
| `evidence_collected` | ✓  Evidence pool: `total_items` items, `promoted_candidates_count` promoted |
| `private_corpus_evidence_injected` | 🧠  Injected `synthetic_count` items from discover; `antipattern_axis_count` antipattern axes |
| `candidate_relevance_filter_failed` | ⚠  Relevance filter failed — keeping all candidates |
| `adaptive_research_cycle_started` | 🔁  Adaptive cycle `cycle`: filling evidence gaps |
| `adaptive_research_cycle_completed` | ✓  Adaptive cycle `cycle` complete (`promoted_candidate_count` promoted) |
| `adversarial_research_cycle_started` | ⚔️  Adversarial cycle `cycle`: arguing against candidates |
| `adversarial_research_cycle_completed` | ✓  Adversarial cycle `cycle` complete (`empty_cells_after` empty cells remain) |
| `synthesis_started` | 🧩  Writing research report — `candidates` candidates, `evidence_count` evidence items |
| `critique_started` | 🧐  Critique: evaluating report comprehensiveness |
| `resynthesis_started` | 🔄  Re-writing report to address `original_high_severity_count` high-severity issues |
| `resynthesis_accepted` | ✓  Re-synthesis accepted (`original_high_severity_count` → `new_high_severity_count`) |
| `resynthesis_rejected` | ↪  Re-synthesis rejected — keeping original (`reason`) |
| `citation_audit_started` | 🔗  Citation audit: verifying citations across `evidence_count` items |
| `citation_audit_batch_started` | &nbsp;&nbsp;⤓ batch `<claim_context>` (`citation_count` citations) |
| `citation_audit_batch_completed` | &nbsp;&nbsp;✓ batch `<claim_context>` — `verified_count`/`citation_count` verified |
| `evaluation_pack_started` | 🧪  Building evaluation pack |
| `evaluation_pack_completed` | ✓  Evaluation pack — `test_case_count` test cases, `metric_count` metrics |
| `claim_audit_started` | 📝  Claim audit: scanning artifacts |
| `claim_audit_completed` | 📝  Claim audit: `total_claims_checked` checked, `uncited_material_claim_count` uncited |
| `artifact_validation_warnings` | ⚠  `warning_count` artifact(s) failed schema; wrote .invalid.json siblings (`files`) |
| `handoff_skipped` | ↪  Handoff artifacts skipped — run `adr handoff <out_dir> --option <name>` after picking a candidate |
| `handoff_writing` | 📝  Writing handoff artifacts (only when `adr handoff` ran) |

### Multi-line content events (render as a small block in chat)

These carry **concrete content** the user wants to see. Render each as a 2-6 line block with the header on its own line, then the items indented. Do not collapse to a single line.

**`decision_context_extracted`** — header `✓  Extracted N context notes (K tags)` then one bullet per `notes[]`:
```
✓  Extracted 3 context notes (3 tags)
  Tags: phase:pre_pmf, deployment:self_hosted_single_vm, cost_sensitivity:high
  • [deployment] Self-hosted is the primary deploy model
    └ from: "self-hosted is the primary deploy model"
  • [deployment] Should fit existing Docker Compose stack
    └ from: "fits the existing Docker Compose"
  • [cost] Budget-sensitive at early stage
    └ from: "budget-sensitive at early stage"
```

These are annotations on the option space, not filters. They flow to synthesis as soft context and appear in the ADR.md header.

**`decision_context_gaps_detected`** — header `⚠  Detected N context gaps (run continues)` then one bullet per gap. **This is informational, not a blocker** — the run proceeds and the follow-up question stage at the end will surface what to sharpen on the next run:
```
⚠  Detected 4 context gaps (run continues)
  • What latency target do you need? (p95 / p99)
  • How many tenants in production today vs in 12 months?
  • Which compliance regimes apply? (SOC2 / HIPAA / GDPR / none)
  • Self-hosted only, or is managed cloud acceptable?
```

**`follow_up_questions_proposed`** — header `✓  Proposed N follow-up questions` then one bullet per `follow_ups[]`:
```
✓  Proposed 3 follow-up questions
  • [deployment_model] (spread 0.84) Self-hosted or managed? The matrix splits cleanly on this axis.
    └ adr deep-research --discover-first --repo . --domain "<DOMAIN>" --decision "self-hosted vector store" --out .adr-runs/<SLUG>-self-hosted
  • [pricing_model] (spread 0.71) Per-vector or per-query pricing? Pinecone bills per dimension; pgvector is free.
    └ adr deep-research --discover-first --repo . --domain "<DOMAIN>" --decision "vector store at >10M vectors budget envelope" --out .adr-runs/<SLUG>-budget
```

**`peers_found`** — header `🤝 Found N peer products` then one bullet per peer (with `evidence_strategy` shown — `architecture`, `adoption`, or `both`):
```
🤝  Found 5 peer products
  • Cal.com (★33k, TypeScript) [architecture] — Multi-tenant SaaS shipping its own auth + scheduling
  • Onyx (★12k, Python) [architecture] — Self-hosted agent runtime with similar agent OS shape
  • Obsidian (closed-source) [adoption] — Read via community signal (r/ObsidianMD, plugin ecosystem)
  • Roam Research (closed-source) [adoption] — Read via community signal (migration write-ups)
  • Notion (closed-source) [both] — SaaS at similar abstraction layer; mixed query set
```

**`peer_research_tasks_added`** — header `🎯 Added N peer-targeted research tasks` then bullets:
```
🎯  Added 5 peer-targeted research tasks
  • Cal.com → how does Cal.com handle vector store for agent memory? (cal.com/docs, github.com/cal-com/cal.com)
  • Onyx → how does Onyx handle vector store for agent memory? (docs.onyx.app)
  …
```

**`research_source_processed`** — the combined per-source beat. One header line for the fetch + preview, then one bullet per top claim. Replaces the previous 4 per-source events (fetching / fetched / claims_extracting / claims_extracted) so 30 sources fire 30 events instead of 120:
```
      ✓ "Architecture · Onyx Docs" (8.1KB, http_fetch_ok, 3 claims, score 0.82)
        └ "Onyx uses Postgres with pgvector as the default vector store. The schema separates per-tenant indexes via..."
        • [pgvector / supports] Onyx ships with pgvector as the default vector store across all deployments.
        • [pgvector / supports] Schema separates per-tenant indexes via tenant_id partition columns.
        • [self_hosted / supports] Default deployment is single-container Docker Compose with embedded Postgres.
```

**`candidate_relevance_filter_completed`** — header + bullet per dropped:
```
🎯  Dropped 2 off-topic candidates: nextjs, postgres_centric_storage
  • nextjs — Framework, not a vector store
  • postgres_centric_storage — Storage stack choice, not a vector store
```

**`comparison_matrix_built`** — header + top strong cells:
```
📊  Matrix: 5 candidates × 13 axes (35 empty, 18 strong, 6 weak)
  • pgvector — strong on fits_existing_stack: "Postgres extension; runs inside the existing 5433 deployment without adding a new container [12]"
  • Onyx → pgvector — strong on production_examples: "Onyx default deploy uses pgvector across all customers [4]"
  • weaviate — weak on fits_existing_stack: "Requires its own container alongside Postgres [9]"
```

**`synthesis_completed`** — header + per-candidate summary:
```
✓  Report written — 2 candidates
  Candidates:
    • pgvector [thick] (strong on fits_existing_stack, cost_envelope, p95_latency)
      └ Pick when: existing Postgres deployment, low-single-digit-M vectors
    • weaviate [medium] (strong on hybrid_search; weak on fits_existing_stack)
      └ Pick when: hybrid search is mandatory and Postgres is not in the stack
```

A run with `candidate_count === 1` just means ADR found one candidate in this space — it's still the reader's call. A run with no candidates means the evidence pool didn't surface any (re-run with sharper context).

**`critique_completed`** — header + top issues:
```
🧐  Critique: 7 issues (0 high-severity, human review NOT recommended)
  Summary: pgvector strong_axes are evidence-backed; one minor citation_mismatch on weaviate's failure_modes cell.
  Top issues:
    • [medium] citation_mismatch: citation [57] discusses OAuth2, not token_based_auth
```

**`citation_audit_completed`** — header + unsupported list (only when N > 0):
```
🔗  Citation audit: 29/30 verified, 1 unsupported
  Unsupported:
    • [21] for candidate:pgvector — "Cited paper discusses HNSW indexes in general, not pgvector specifically"
```

**`run_completed`** — final summary block (lives at the end of Step 7).

### Pacing

Stream every event individually. Do NOT consolidate multiple events into one message. The only exception: when `research_source_fetching` fires for many URLs in the same round, render them consecutively on adjacent lines (still one chat message per event).
| `handoff_skipped` | ↪  Handoff artifacts skipped — `adr handoff <out_dir> --option <name>` after picking |
| `run_completed` | ✅  Run complete — research report written |

Unknown event types: print as `<event_type>` with no message body. Don't lose them.

**Stream every event individually.** Each event line in `events.jsonl` is meant to be a beat the user sees in chat — not a candidate for batching. Surface each event the moment it lands. The kernel's job is to emit beats at the granularity that makes sense for streaming UX; the slash command's job is to translate each one to a single chat line. Do NOT consolidate multiple events into one message even when they land in the same tick.

The only exception: when the same event_type fires very rapidly (e.g. `research_source_fetching` for 8 URLs in a single round), it's OK to render them on consecutive lines without skipping any.

## Step 6.5 — Clarification is non-blocking

ADR no longer halts the run on thin context. If `decision_context_gaps_detected` fires, the run continues — burning the evidence budget on a thin PRD is the lesser failure mode compared to forcing the user through a clarification dialog before they've seen anything.

What you do as the slash command:

1. Surface the gap event when it lands (multi-line render — see the table above) so the user knows what's missing.
2. **Don't kill the tail. Don't re-invoke.** Let the run finish.
3. After the run, the `follow_up_questions_proposed` event carries pre-filled `adr deep-research` commands targeting the matrix's highest-spread axes. Show them to the user as quick-pick next steps for a sharper run.

If the user wants to add context before the run completes, the right move is to cancel the current run, edit `.adr-runs/<SLUG>/decision-context.json` to add notes, and re-run with the same `--out` — `adr` will pick up the edited file as-is.

## Step 7 — When the deep-research task finishes

You'll be notified when the background deep-research task completes (the one from Step 4, NOT the tail task). At that point:

1. Stop the `tail -F` task (let it die naturally — it has no more input — or kill it explicitly via Bash).
2. **Read `ADR.md` first.** This is the founder-facing research report — executive summary, option space, per-candidate sections (`what evidence shows` / `what evidence does not show` / pick / avoid / citations), cross-cutting tradeoffs, open questions, where to dig deeper, references. It's what the user actually wants to read.

```bash
cat .adr-runs/<SLUG>/ADR.md
```

3. Then read `research-report.json` if you need the structured `options[]` for Step 8's summary.

```bash
cat .adr-runs/<SLUG>/research-report.json
```

4. If `ADR.md` doesn't exist, the run did not reach the artifact stage. Inspect `.adr-runs/<SLUG>/state.json` (the kernel writes `{"status": "crashed", "error": ...}` on every failure path now) and the tail of `events.jsonl` to find out what died. Report clearly to the user. Salvageable run state: `evidence.json`, `comparison-matrix.json`, and `critique.json` may still be present and useful even when the run crashed.

## Step 8 — Summarize the result

Read `research-report.json` and `state.json`:

- **`candidate_count > 0`** — the option space is mapped. Show:
  ```
  Candidates:   <options[].name>, comma-separated
  Depth split:  <thick count> thick, <medium> medium, <thin> thin
  Matrix:       <candidates>×<axes>, <empty_cells> empty, <strong_cells> strong
  Citations:    <verified_count>/<total_citations> verified
  Open Qs:      <open_questions.length>
  Dig deeper:   <follow_ups.length> research threads proposed
  ```
  Then offer: "Want me to walk through each candidate from `ADR.md`, or look at the research threads to dig deeper?"

  When `candidate_count === 1`, frame it as "ADR found one candidate in this space" — not "the answer." The dig-deeper section is how to widen the search if the lone candidate feels too thin.

- **`candidate_count === 0`** — no candidates surfaced. Show:
  ```
  Result:     no candidates surfaced from the evidence pool
  Reason:     read critique.json
  Next step:  re-run with sharper context (see follow-up-questions.json),
              or run `adr supersede` once more evidence is available
  ```

If `critique` flagged `recommend_human_review: true`, append:

```
⚠  recommend_human_review = true — the critique flagged structural issues with the report.
   Open .adr-runs/<SLUG>/ADR.md before acting.
```

## Step 9 — Your job after the report

The report does not pick a candidate. That's the human's call. Read the per-candidate sections in `ADR.md`, weigh them against your team-side context (existing infrastructure, hiring plans, vendor relationships, budget), then:

- Walk through each candidate's tradeoffs from `ADR.md`
- Walk the comparison matrix cell by cell
- Look at `follow-up-questions.json` and pick a sharper research thread to chase next
- Once you've picked a candidate, run `adr handoff <out_dir> --option <name>` to generate the implementation contract (`agent-guardrails.md` + `execution-handoff.json`). Pass `--write-evaluation-pack` to also generate `domain-evaluation-pack.json`.

## Hard rules for the implement path

When the user has run `adr handoff` and is ready to implement, the agent's job:

1. **Read the chosen candidate's block.** `execution-handoff.json` is scoped to one candidate by `--option`. Honor THAT candidate's `strong_axes`, `weak_axes`, `when_to_pick`, `when_not_to_pick`, and `citations`.
2. **Respect `agent-guardrails.md`** for the chosen candidate.
3. **Run against `domain-evaluation-pack.json`** test cases before declaring done (only if it was generated).
4. If something the cited evidence doesn't support comes up, surface the gap — don't paper over it, and don't silently swap to a different candidate.

## Failure modes

- **doctor reports missing keys**: invoke `/adr:doctor`. Do not run without them.
- **adr deep-research exits non-zero**: the tail will stop emitting. Read `.adr-runs/<SLUG>/state.json` for the failure reason and `events.jsonl` for the last events. Show the user.
- **`recommend_human_review: true`**: do NOT proceed to implement automatically.
- **Run exceeds 10 minutes**: most likely a rate-limited search provider. Inspect events, suggest switching providers via `/adr:doctor`.

## Why background bash + tail instead of the MCP tool

The MCP server's `adr_deep_research` tool is request/response — it blocks for 3–6 minutes and returns the handoff. Silent. We use bash + tail instead so events stream live. The MCP server remains available for hosts (Cursor, Codex) that don't have a chat surface to stream into.
