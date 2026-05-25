---
description: Discover the team's code-review principles from their own repo. Scans for code-review lenses (state-boundaries, llm-call-discipline, etc.), extracts positive patterns + antipatterns + ambiguities with file:line citations, walks the user through an interactive interview to confirm, and writes `.adr/principles.{md,json}`. Use when the user asks to set up team principles, or before running `/adr:review` for the first time.
---

# /adr:principles — Discover the team's code-review principles

Use when the user wants the bot to learn their team's conventions so PR review can cite the team's own code as the reference.

## Step 1 — Check the environment

```bash
npx -y --package=github:beevibe-ai/architecture-deep-research adr-doctor
```

`adr principles` only needs an LLM provider (no web search). If that one is missing, invoke `/adr:doctor`.

## Step 2 — Run principles discovery via the MCP server

Use the `adr_principles` MCP tool with `non_interactive: true` — you (the bot) will run the interview conversationally in chat instead of the readline prompt:

```json
{
  "repo_path": ".",
  "non_interactive": true
}
```

The tool returns the lenses it found, the per-lens patterns (the actual content lives in `.adr/principles.json` on disk), and an `interview_skipped: true` flag.

Runs in 1-3 minutes and costs $0.05-$0.20 on `gpt-4.1-mini`.

## Step 3 — Show the user what we found

Read `.adr/principles.json` to see the full structure, especially the per-lens ambiguities the LLM surfaced (those are the questions the user should resolve). Then show the user:

- **The lenses** — name + rationale for each. These are the angles a senior reviewer would catch in a PR for this codebase.
- **The principles per lens** — the top 2-3 strongest principles per lens, with the team file:line they cite.

Be concrete. "DO: state lives in `/stores/*Store.ts`, not component-local useState (lens: state-boundaries) — cited to `web/src/stores/chatStore.ts:14`". Not "DO: maintain clean architecture".

## Step 4 — Walk through ambiguities one at a time

For each ambiguity in `.adr/principles.json` (each lens may have its own `ambiguities` block in the per-lens extractions), show the user:

- The ambiguity description
- Both sides of the conflict, with `file:line` citations
- Ask their preference in one short question, with 2-3 concrete options when possible

**Do not dump all ambiguities at once.** Walk them one at a time. The user is lazy and hates editing — make the choices feel like a conversation, not homework.

Capture each answer.

## Step 5 — Re-run with the answers

Re-run `adr_principles` if any answers materially change the principle set. For most cases, you can update `.adr/principles.json` in place by appending the user's answers to the `interview_log` array and re-running the consolidator manually with the CLI:

```bash
npx adr principles init  # interactive mode picks up the file
```

For Phase 1 MVP, simpler: skip the re-run. Just present the v0 principles + confirmed answers to the user and tell them they can re-run later if their conventions drift.

## Step 6 — Confirm + suggest the next step

> Your team has N principles across M lenses, written to `.adr/principles.md`. Now PR review knows what to look for.
>
> Run `/adr:review <PR#>` to check a PR against this list — comments will cite your team's own file:line.

## Notes for the bot

- **Do not invent principles.** Only show the user principles the tool returned. If the LLM hallucinated something obviously wrong, flag it but do not delete it without confirmation.
- **Lead with the team example.** A principle without a team file:line citation is unfounded. Skip it.
- **Plain language.** "Stop putting state in components" not "delineate state boundaries via reactive store primitives".
- The interactive interview is the highest-value step. Skip it only if the user is in a hurry — and tell them they can re-run later.
