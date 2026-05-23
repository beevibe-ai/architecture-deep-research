---
description: Run a full Architecture Deep Research pipeline against the current repo and a named decision. Scans the repo for patterns and anti-patterns, drafts a PRD, runs live deep-research with citation audits, and returns a decision handoff the coding agent can implement under.
---

# /adr:decide — Architecture Deep Research

Use when the user is making an architecture decision and wants ADR to run the full pipeline. Examples of trigger phrases: "pick a topology", "should we use Kafka or Postgres LISTEN", "what retrieval architecture", "decide auth provider", "architecture deep research".

## Step 1 — Confirm the decision name

Ask the user **one** question (skip if they already named it):

> What's the architecture decision you're making? (e.g. "event bus topology", "retrieval architecture", "auth provider")

Capture as `<DECISION>`.

## Step 2 — Check the environment

Run the doctor first. It's cheap, prints what's missing, and tells the user what to fix:

```bash
adr-doctor
```

If the doctor exits non-zero (missing search provider or LLM provider), tell the user to run:

```bash
adr-doctor setup
```

…and wait for them to come back. Do NOT proceed to deep-research with a broken environment.

## Step 3 — Run discover-first deep-research via the MCP server

Use the `adr_deep_research` MCP tool (registered by this plugin) with these arguments:

```json
{
  "discover_first": true,
  "repo_path": ".",
  "domain": "<infer from README, package.json, or the user's earlier messages>",
  "decision": "<DECISION>",
  "out_dir": ".adr-runs/<slug-of-decision>"
}
```

This:

1. Scans the user's repo and drafts a PRD (no network calls, ~10s).
2. Runs the full ADR pipeline against the draft (research, knowledge map, comparison matrix, synthesis, citation audit, evaluation pack — typically 3–6 minutes).
3. Returns the parsed `execution-handoff.json` so you can summarize.

Tell the user it will take 3–6 minutes before you call the tool. A silent wait reads like a hang.

## Step 4 — Summarize the result

The tool response includes a `handoff` object. Show the user 4–6 lines:

```
Selected:  <handoff.selected_topology>
Required:  <two most important required_invariants>
Avoid:     <forbidden_topologies as a comma list>
Matrix:    <candidates>×<axes>, <empty_cells> empty cells, <strong_cells> strong
Citations: <citation_audit_summary.verified_count>/<total_citations> verified
```

If `handoff.critique_summary.recommend_human_review` is `true`, add a line:

```
⚠  recommend_human_review = true — the critique pass flagged the synthesis.
   Open .adr-runs/<slug>/ADR.md and walk the borderline before implementing.
```

## Step 5 — Offer next steps

Ask which the user wants:

- Open the human-readable decision record (`ADR.md`) and walk through it
- Walk the comparison matrix cell by cell
- Implement under the handoff (read `execution-handoff.json` and treat it as a hard contract)

## Hard rules for the implement path

If the user says "implement," read `<out_dir>/execution-handoff.json` and treat it as a contract:

- Honor every `required_invariant` in the code you write
- Never reach for anything in `forbidden_topologies`
- Run against `domain-evaluation-pack.json` test cases before declaring done
- If you can't satisfy an invariant, stop and surface the conflict — don't paper over it

## Failure modes

- **`adr-doctor` reports missing keys**: the user runs `adr-doctor setup`. Do not try to deep-research without them.
- **MCP tool returns `isError`**: read the error text. Most common cause is rate-limited search provider — switch via `adr-doctor setup` to a different one.
- **`recommend_human_review: true`**: do NOT proceed to implement automatically. Show the borderline first.
- **Run exceeded 10 minutes**: the kernel almost certainly failed but kept retrying. Inspect `<out_dir>/events.jsonl` for the last events and ask the user how to proceed.
