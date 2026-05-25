---
description: Review a PR (or local diff) against the team's principles discovered by `/adr:principles`. Detects violations, walks the user through them conversationally one at a time, posts approved comments as inline PR comments via gh CLI. Use when the user says "review this PR", "check my staged diff", or "look at PR 42".
---

# /adr:review — Dynamic PR review against team principles

Use when the user wants the bot to PR-review a change against the team's own conventions, not generic style rules. Requires `/adr:principles` to have run at least once.

## Step 0 — Check principles exist

If `.adr/principles.json` doesn't exist in the repo, tell the user:

> Your team principles haven't been discovered yet. Run `/adr:principles` first — it scans the repo and learns what your team's conventions are, so PR review can cite your own code.

Stop. Do not proceed.

## Step 1 — Figure out what to review

If the user typed `/adr:review 42`, that's PR #42. Otherwise ask one short question:

> What do you want me to review?
> 1. A PR — give me the number
> 2. Your staged changes (`git diff --staged`)
> 3. Your current branch vs main

Skip the question if the user already said.

## Step 2 — Detect violations via the MCP server

Call `adr_review` with the appropriate source:

```json
{ "pr_number": 42 }
```

or

```json
{ "staged": true }
```

or

```json
{ "branch": "main" }
```

The tool returns structured `violations` (each with principle_id, file, line, severity, message, suggested_fix) and the matching `principles` array (id, rule, rationale, examples_to_follow).

Runs in 30-90 seconds depending on diff size. Costs $0.01-$0.05 on `gpt-4.1-mini`.

## Step 3 — If no violations: ship it

If `violation_count` is 0:

> No principle violations in this change. Ship it.

Stop.

## Step 4 — Walk through violations one at a time

For each violation in the returned list:

1. Show the user this block:

   ```
   [N/total] <SEVERITY-COLORED> file.ts:LINE
   
   Team principle: <principle.rule>
   <principle.rationale>
   
   Why this hunk fails: <violation.message>
   
   Team example to follow: <principle.examples_to_follow[0]>
   Fix: <violation.suggested_fix>
   ```

2. Ask one short question:

   > Post / edit / skip?

3. Capture the answer. If "edit", let them rewrite the comment text. Track which violations get accepted.

**Do not batch them.** Walk through one at a time, even if there are 10. The user is lazy — make it a conversation, not a triage queue. They can say "post all the rest" to short-circuit.

## Step 5 — Post the accepted ones

Only ask this if there are accepted violations AND the source was a PR. (For local diffs there's nowhere to post.)

> Ready to post N comments to PR #42?

If yes, get PR metadata with one `gh` call:

```bash
gh pr view <N> --json headRefOid,baseRepository,baseRepositoryOwner
```

Then for each accepted violation, post via `gh api`:

```bash
gh api --method POST \
  "repos/<owner>/<repo>/pulls/<N>/comments" \
  -f body="<rendered comment>" \
  -f commit_id="<headRefOid>" \
  -f path="<violation.file>" \
  -F line=<violation.line> \
  -f side=RIGHT
```

The rendered comment for each violation should look like:

```
Team principle: <principle.rule>

> <principle.rationale>

<violation.message>

**Team example to follow:** `<principle.examples_to_follow[0]>`

**Fix:** <violation.suggested_fix>

_From `adr review` · lens: `<principle.lens>` · principle: `<principle.id>`_
```

## Step 6 — Summarize

> Posted N of M comments to PR #42. Skipped K. The team's principles are evolving — re-run `/adr:principles` periodically as your conventions shift.

## Notes for the bot

- **One at a time, not all at once.** The walkthrough is the whole point — batch output is exactly what existing PR bots do, and it's bad.
- **Cite the team's own code.** Every comment must include the `examples_to_follow` reference. "Here's the rule, here's where we already do it right" is the formula.
- **Don't post style nitpicks.** This is principles-based review, not lint. If the LLM surfaced something that's clearly cosmetic, drop it before showing the user.
- **Severity colors:** high = red, medium = yellow, low = gray. Honest signal helps the user triage at a glance.
- **For local diffs (staged / branch),** there's nothing to post — just show the violations and let the user fix locally.
