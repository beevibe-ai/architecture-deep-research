---
description: Run a full Architecture Deep Research pipeline against the current repo and a named decision. Scans the repo for patterns and anti-patterns, drafts a PRD, runs live deep-research with citation audits, and returns a decision handoff the coding agent can implement under.
---

# /adr:decide — Architecture Deep Research

Use when the user is making an architecture decision and wants ADR to run the full pipeline. Trigger phrases: "pick a topology", "should we use Kafka or Postgres LISTEN", "what retrieval architecture", "decide auth provider", "architecture deep research".

The run takes 3–6 minutes. **You MUST stream progress to the user as events land — silent waiting is bad UX.** This command uses background bash + `tail -F` + the `Monitor` tool to surface each event in chat as it happens, instead of blocking on the MCP tool until completion.

## Step 1 — Confirm the decision name AND the decision kind

Ask **one** question (skip if the user already named it):

> What's the architecture decision? (e.g. "event bus topology", "retrieval architecture", "auth provider")

Capture as `<DECISION>`. Derive `<SLUG>` by lowercasing and replacing non-alphanum with `-`. Derive `<DOMAIN>` from the repo's README / package.json — if you can't tell, ask.

Then decide the **decision kind**. There are two:

- **`family`** — the user is picking an architecture pattern / topology (e.g. "retrieval topology", "event bus architecture", "consistency model"). Candidates are patterns.
- **`concrete`** — the user is picking a specific product / vendor / library / service (e.g. "auth provider", "queue library", "logging service", "OAuth vendor"). Candidates are named products.

Auto-detect from the decision name. ADR's CLI applies the same heuristic when `--decision-kind` is omitted, but you should ask the user to confirm rather than assume — this is the difference between "ADR picks 'token-based auth'" and "ADR picks 'Clerk'", and that mismatch is exactly the failure mode this feature exists to fix.

Use `AskUserQuestion` with the user's `<DECISION>` filled in:

> Question: "For '<DECISION>', do you want to pick an architecture pattern (family) or a specific product/vendor (concrete)?"
>
> Options:
> - **Family — architecture pattern** (e.g. token-based auth, graph retrieval)
> - **Concrete — specific product** (e.g. Clerk, BullMQ, Stripe)

Capture as `<KIND>` (either `family` or `concrete`).

If the user picks **concrete** but the run is going to be expensive, briefly tell them: "Concrete mode adds vendor-grade axes (pricing, lock-in, SDK quality, on-prem, ecosystem health). The matrix will be wider; the synthesis will commit to a specific product."

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
  --decision-kind <KIND> \
  --out .adr-runs/<SLUG>
```

Tell the user something like: *"Kicked off — typical run is 3–6 minutes. I'll surface each stage as it happens."*

## Step 5 — Tail the event log in the background

Second Bash call, also `run_in_background: true`. **Capture this task id too** so you can stop the tail when the deep-research finishes.

```bash
tail -F .adr-runs/<SLUG>/events.jsonl
```

Each line that lands is a JSON object: `{"ts":"...","type":"<event_type>", ...extra_fields}`.

## Step 6 — Stream events to the user via Monitor

Use the `Monitor` tool on the `tail -F` task id. Each new stdout line is a notification with one event. Pretty-print to the user with a short one-line summary. **Use this mapping** — do not invent or skip events:

| event_type | One-line message to the user |
| --- | --- |
| `discover_first_chained` | 🔍  Discover: scanning the repo first |
| `repo_scanned` | ✓  Repo scan done — `N` files, `K` manifests, `D` deploy configs (use `file_count`, `manifest_count`, `deploy_config_count`) |
| `principles_extracted` | ✓  Discovered `N` patterns + `M` anti-patterns from the repo |
| `constraints_extracted` | ✓  Extracted stack + `K` compliance signals |
| `pdr_drafted` | ✓  Drafted PRD — moving to live research |
| `discover_completed` | ✓  Discover stage complete |
| `run_started` | 🚀  Deep-research started — `<domain>`: `<decision>` |
| `strategic_context_created` | ✓  Strategic context: `N` entities, `M` query shapes |
| `run_waiting_for_clarification` | ❓  Clarification needed — go to **Step 6.5** |
| `research_plan_created` | 🌐  Planned `N` research tasks |
| `research_batch_started` | 🔎  Dispatching parallel research agents (max `N`) |
| `research_agent_started` | &nbsp;&nbsp;🔍  task: `<task_title or task_id>` |
| `research_round_started` | &nbsp;&nbsp;&nbsp;&nbsp;round `N` searching |
| `research_round_judged` | &nbsp;&nbsp;&nbsp;&nbsp;round `N` judge: complete=`<value>` |
| `research_round_completed` | &nbsp;&nbsp;&nbsp;&nbsp;round `N` ✓ (`N` evidence) |
| `research_agent_finished` | &nbsp;&nbsp;✓  task done (`N` evidence) |
| `evidence_collected` | ✓  Evidence pool: `N` items, `K` promoted candidates |
| `private_corpus_evidence_injected` | 🧠  Injected `N` private_corpus items from discover; `K` antipattern axes added |
| `candidate_relevance_filter_completed` | 🎯  Dropped `N` off-topic candidates from promoted pool (`dropped_names`) |
| `candidate_relevance_filter_failed` | ⚠  Relevance filter failed — keeping all candidates (LLM error) |
| `comparison_matrix_built` | 📊  Matrix: `C` candidates × `A` axes (`E` empty cells) |
| `adaptive_research_cycle_started` | 🔁  Adaptive cycle `N`: filling evidence gaps |
| `adaptive_research_cycle_completed` | ✓  Adaptive cycle `N` complete (`K` promoted candidates now) |
| `adversarial_research_cycle_started` | ⚔️  Adversarial cycle `N`: arguing against candidates |
| `adversarial_research_cycle_completed` | ✓  Adversarial cycle `N` complete (`E` empty cells remain) |
| `critique_completed` | 🧐  Critique: `N` issues (`H` high-severity) |
| `resynthesis_started` | 🔄  Re-synthesizing to address `N` high-severity issues |
| `resynthesis_accepted` | ✓  Re-synthesis accepted (`N` → `M` high-severity, selected: `<value>`) |
| `resynthesis_rejected` | ↪  Re-synthesis rejected — keeping original (`reason`) |
| `citation_audit_completed` | 🔗  Citation audit: `V/T` verified, `U` unsupported |
| `claim_audit_completed` | 📝  Claim audit complete |
| `decision_downgraded_by_critique` | ⚠️  Decision downgraded by critique |
| `decision_downgraded_by_citation_audit` | ⚠️  Decision downgraded by citation audit |
| `run_completed` | ✅  Run complete — synthesizing handoff... |

Unknown event types: print as `<event_type>` with no message body. Don't lose them.

**Pacing:** if many events land in quick succession (e.g. `research_round_*` × 20), batch them into a single update so chat doesn't get spammed. e.g. "Research: 6 tasks dispatched, 12 rounds, 47 evidence items so far."

## Step 6.5 — Handle the clarification gate (only if `run_waiting_for_clarification` fires)

The clarification gate is **blocking by default**. When it fires, the deep-research task will exit having only written `strategic-context.json`, `clarification.json`, and `state.json` (status: `needs_clarification`). The matrix, synthesis, and handoff stages do NOT run — burning the evidence budget on a guaranteed-low-confidence answer is the failure mode this gate exists to prevent.

1. Kill the `tail -F` background task — it will hang otherwise.
2. Read the questions:

```bash
cat .adr-runs/<SLUG>/clarification.json
```

3. Ask the user with `AskUserQuestion`. Use one question per `AskUserQuestion` call only if there are 1–4 questions and they have natural options; for free-form latency / scale / compliance values use a single open question with the whole list shown to the user as context, then read their full text reply.
4. Re-invoke `adr deep-research` with `--clarification-answers '<text>'`, threading every answer the user gave. Use the **same** `--out` so events.jsonl keeps accumulating:

```bash
npx -y --package=github:beevibe-ai/architecture-deep-research adr \
  deep-research --discover-first \
  --repo . \
  --domain "<DOMAIN>" \
  --decision "<DECISION>" \
  --decision-kind <KIND> \
  --out .adr-runs/<SLUG> \
  --clarification-answers "$(cat <<'EOF'
- Latency target: <user answer>
- Expected scale: <user answer>
- Compliance: <user answer>
- ...
EOF
)"
```

5. Restart the `tail -F` task and resume streaming events. The strategic-context extraction will re-run with the answers folded in, and the gate will not re-block.

**Do NOT default to `--no-clarify`** — the user has to opt out of clarification explicitly. The point of the gate is that running with no answers wastes 3+ minutes of evidence collection to land on a `deferred` run with no viable options.

## Step 7 — When the deep-research task finishes

You'll be notified when the background deep-research task completes (the one from Step 4, NOT the tail task). At that point:

1. Stop the `tail -F` task (let it die naturally — it has no more input — or kill it explicitly via Bash).
2. Read the handoff file:

```bash
cat .adr-runs/<SLUG>/execution-handoff.json
```

3. If the file doesn't exist, the run did not reach the handoff stage. Inspect `.adr-runs/<SLUG>/state.json` and the last events to figure out why. Report the failure clearly to the user.

## Step 8 — Summarize the result

Read the handoff and branch on `mode`:

- **`mode: "recommended"`** — one option dominates. Show:
  ```
  Recommended:  <recommendation.name>
  Why:          <recommendation.why, one line>
  Other options: <options[].name except the recommended one, comma-separated>
  Matrix:       <candidates>×<axes>, <empty_cells> empty, <strong_cells> strong
  Citations:    <verified_count>/<total_citations> verified
  ```

- **`mode: "ranked_options"`** — multiple viable options with genuine tradeoffs. Show:
  ```
  Mode:        ranked_options — no single recommendation
  Options:     <options[].name>, comma-separated
  Matrix:      <candidates>×<axes>, <empty_cells> empty, <strong_cells> strong
  Citations:   <verified_count>/<total_citations> verified
  ```
  Then offer: "Want me to walk through each option's tradeoffs from `ADR.md`?"

- **`mode: "deferred"`** — no viable options. Show:
  ```
  Mode:       deferred — no viable options produced
  Reason:     read critique.json
  Next step:  re-run with sharper context, or run `adr supersede` once more evidence is available
  ```

If `critique_summary.recommend_human_review` is `true`, append:

```
⚠  recommend_human_review = true — the critique flagged structural issues with the option set.
   Open .adr-runs/<SLUG>/ADR.md before implementing.
```

## Step 9 — Offer next steps

Ask which the user wants:

- Open `ADR.md` and walk through each option's tradeoffs
- Walk the comparison matrix cell by cell
- Implement under one option's contract (ask which option first if `mode == ranked_options`; honor that option's `required_invariants` and `forbidden_topologies` from `execution-handoff.json` -> `options[]`)

## Hard rules for the implement path

If the user says "implement," `execution-handoff.json` carries per-option contracts under `options[]`. The agent's job:

1. **Pick one option.** If `mode == "recommended"`, default to `recommendation.name` unless the user picks differently. If `mode == "ranked_options"`, ask which option before writing any code — there is no default.
2. **Honor THAT option's `required_invariants`** in the code you write.
3. **Never reach for anything in THAT option's `forbidden_topologies`.**
4. Run against `domain-evaluation-pack.json` test cases before declaring done.
5. If you cannot satisfy an invariant for the chosen option, stop and surface the conflict — don't paper over it, and don't silently swap to a different option.

## Failure modes

- **doctor reports missing keys**: invoke `/adr:doctor`. Do not run without them.
- **adr deep-research exits non-zero**: the tail will stop emitting. Read `.adr-runs/<SLUG>/state.json` for the failure reason and `events.jsonl` for the last events. Show the user.
- **`recommend_human_review: true`**: do NOT proceed to implement automatically.
- **Run exceeds 10 minutes**: most likely a rate-limited search provider. Inspect events, suggest switching providers via `/adr:doctor`.

## Why background bash + tail instead of the MCP tool

The MCP server's `adr_deep_research` tool is request/response — it blocks for 3–6 minutes and returns the handoff. Silent. We use bash + tail instead so events stream live. The MCP server remains available for hosts (Cursor, Codex) that don't have a chat surface to stream into.
