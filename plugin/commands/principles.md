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

## Step 2 — Set expectations, then run

Before calling the tool, tell the user EXACTLY what's about to happen — the tool runs for 2-4 minutes with no other visible output, so without this the user just sees a spinner.

Print something like:

> Running principles discovery on the repo. This takes ~2-4 minutes and runs in five steps:
>
> 1. Scan the repo (files, manifests, docs) — instant
> 2. Sample ~24 representative source files — instant
> 3. **Extract product intent + discover review lenses** (parallel LLM, ~15s)
> 4. Per-lens pattern extraction (parallel LLM, ~30s)
> 5. Consolidate + cite-verify + write `.adr/principles.{md,json}` (~30s)
>
> Cost: ~$0.15 on gpt-4.1-mini. You'll see the result when it's done.

THEN call the `adr_principles` MCP tool with `non_interactive: true`:

```json
{
  "repo_path": ".",
  "non_interactive": true
}
```

The MCP server emits `notifications/message` for every step, and `notifications/progress` when the client opts in via `_meta.progressToken`. Some clients surface these in the spinner; others don't. Either way the upfront step list gives the user something to read.

The tool returns the lenses, the per-lens patterns, AND the product intent block (`identity`, `architectural_intent`, `product_philosophy`, `non_goals`). The full content lives in `.adr/principles.{md,json}` on disk.

## Step 3 — Show the user what we found

Read `.adr/principles.json` to see the full structure. Then show the user — **lead with the product portrait, NOT the lint rules**:

1. **What this is** — the `identity` field. One sentence on what the product actually is.
2. **Architectural intent** — the 3-6 foundational decisions from `architectural_intent`. Each with its `why` and the files cited.
3. **Product philosophy** — the 3-6 recurring design principles from `product_philosophy`. These are the team's voice — quote verbatim where pulled from CLAUDE.md / AGENTS.md.
4. **Non-goals** — what the team explicitly chose NOT to do. Often the most telling part.
5. **Code-level lenses + their principles** — show top 2-3 strongest per lens, with team `file:line` citations.

Be concrete. "DO: state lives in `/stores/*Store.ts`, not component-local useState (lens: state-boundaries) — cited to `web/src/stores/chatStore.ts:14`". Not "DO: maintain clean architecture".

The order matters: the product portrait makes the user say "yes, this gets us" before they dive into the code rules. Reversing it makes the output read like a lint config.

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
