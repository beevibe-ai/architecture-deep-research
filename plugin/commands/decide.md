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
| `research_plan_created` | 🌐  Planned `N` research tasks |
| `research_batch_started` | 🔎  Dispatching parallel research agents (max `N`) |
| `research_agent_started` | &nbsp;&nbsp;🔍  task: `<task_title or task_id>` |
| `research_round_started` | &nbsp;&nbsp;&nbsp;&nbsp;round `N` searching |
| `research_round_judged` | &nbsp;&nbsp;&nbsp;&nbsp;round `N` judge: complete=`<value>` |
| `research_round_completed` | &nbsp;&nbsp;&nbsp;&nbsp;round `N` ✓ (`N` evidence) |
| `research_agent_finished` | &nbsp;&nbsp;✓  task done (`N` evidence) |
| `evidence_collected` | ✓  Evidence pool: `N` items, `K` promoted candidates |
| `private_corpus_evidence_injected` | 🧠  Injected `N` private_corpus items from discover; `K` antipattern axes added |
| `comparison_matrix_built` | 📊  Matrix: `C` candidates × `A` axes (`E` empty cells) |
| `adaptive_research_cycle_started` | 🔁  Adaptive cycle `N`: filling evidence gaps |
| `adaptive_research_cycle_completed` | ✓  Adaptive cycle `N` complete (`K` promoted candidates now) |
| `adversarial_research_cycle_started` | ⚔️  Adversarial cycle `N`: arguing against candidates |
| `adversarial_research_cycle_completed` | ✓  Adversarial cycle `N` complete (`E` empty cells remain) |
| `critique_completed` | 🧐  Critique: `N` issues (`H` high-severity) |
| `citation_audit_completed` | 🔗  Citation audit: `V/T` verified, `U` unsupported |
| `claim_audit_completed` | 📝  Claim audit complete |
| `decision_downgraded_by_critique` | ⚠️  Decision downgraded by critique |
| `decision_downgraded_by_citation_audit` | ⚠️  Decision downgraded by citation audit |
| `run_completed` | ✅  Run complete — synthesizing handoff... |

Unknown event types: print as `<event_type>` with no message body. Don't lose them.

**Pacing:** if many events land in quick succession (e.g. `research_round_*` × 20), batch them into a single update so chat doesn't get spammed. e.g. "Research: 6 tasks dispatched, 12 rounds, 47 evidence items so far."

## Step 7 — When the deep-research task finishes

You'll be notified when the background deep-research task completes (the one from Step 4, NOT the tail task). At that point:

1. Stop the `tail -F` task (let it die naturally — it has no more input — or kill it explicitly via Bash).
2. Read the handoff file:

```bash
cat .adr-runs/<SLUG>/execution-handoff.json
```

3. If the file doesn't exist, the run did not reach the handoff stage. Inspect `.adr-runs/<SLUG>/state.json` and the last events to figure out why. Report the failure clearly to the user.

## Step 8 — Summarize the result

Show the user a tight 4–6 line summary:

```
Selected:  <selected_topology>
Required:  <2 most important required_invariants>
Avoid:     <forbidden_topologies as a comma list>
Matrix:    <candidates>×<axes>, <empty_cells> empty, <strong_cells> strong
Citations: <verified_count>/<total_citations> verified
```

If `critique_summary.recommend_human_review` is `true`, append:

```
⚠  recommend_human_review = true — the critique flagged the synthesis.
   Open .adr-runs/<SLUG>/ADR.md before implementing.
```

## Step 9 — Offer next steps

Ask which the user wants:

- Open `ADR.md` and walk through the human-readable decision record
- Walk the comparison matrix cell by cell
- Implement under the handoff (read `execution-handoff.json`, treat it as a hard contract)

## Hard rules for the implement path

If the user says "implement," treat `execution-handoff.json` as a contract:

- Honor every `required_invariant` in the code you write.
- Never reach for anything in `forbidden_topologies`.
- Run against `domain-evaluation-pack.json` test cases before declaring done.
- If you cannot satisfy an invariant, stop and surface the conflict — don't paper over it.

## Failure modes

- **doctor reports missing keys**: invoke `/adr:doctor`. Do not run without them.
- **adr deep-research exits non-zero**: the tail will stop emitting. Read `.adr-runs/<SLUG>/state.json` for the failure reason and `events.jsonl` for the last events. Show the user.
- **`recommend_human_review: true`**: do NOT proceed to implement automatically.
- **Run exceeds 10 minutes**: most likely a rate-limited search provider. Inspect events, suggest switching providers via `/adr:doctor`.

## Why background bash + tail instead of the MCP tool

The MCP server's `adr_deep_research` tool is request/response — it blocks for 3–6 minutes and returns the handoff. Silent. We use bash + tail instead so events stream live. The MCP server remains available for hosts (Cursor, Codex) that don't have a chat surface to stream into.
