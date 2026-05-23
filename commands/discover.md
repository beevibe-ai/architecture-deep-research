---
description: Run only the discover stage. Scans the local repo for patterns and anti-patterns, drafts a PRD (`pdr.draft.md`), and stops. Use when the user wants to see what ADR infers from the codebase before paying for a full deep-research run.
---

# /adr:discover — Repo scan and PRD draft

Use when the user wants the cheap, fast preview: "what does ADR think about my repo?", "draft a PRD I can edit", "what patterns are in this codebase?".

## Step 1 — Confirm the decision name

Ask the user (skip if they already named it):

> What architecture decision is the PRD for? (e.g. "event bus topology", "retrieval architecture")

Capture as `<DECISION>`.

## Step 2 — Check the environment

```bash
adr-doctor
```

`adr discover` only needs an LLM provider (no web search). If that one is missing, tell the user to run `adr-doctor setup`.

## Step 3 — Run discover via the MCP server

Use the `adr_discover` MCP tool:

```json
{
  "repo_path": ".",
  "decision": "<DECISION>",
  "out_dir": ".adr-runs/<slug>-discover"
}
```

Runs in 15–60 seconds and costs under a cent on `gpt-4.1-mini`.

## Step 4 — Show the user the artifacts

The tool response gives you `pattern_count`, `antipattern_count`, and the path to `pdr.draft.md`. Read `pdr.draft.md` and show the user:

- The 3 most interesting patterns (with their file:line citations)
- The 2 most interesting anti-patterns (with their reasons)
- The Open questions section, verbatim — these are what the user must fill in before deep-research

## Step 5 — Offer next steps

- Edit `pdr.draft.md` to fill in Open questions, then run `/adr:decide` (which will use the draft as input via `--input-path`)
- Run `/adr:decide` directly with `discover_first: true` and let it skip the manual review step
- Pipe the draft into a GitHub issue comment (for the bot workflow)
