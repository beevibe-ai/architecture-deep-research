---
description: Install Claude Code + git pre-commit hooks that surface team principles at write time and block commits that violate high-severity rules. Use when the user wants to wire ADR's principles into their everyday workflow so they never see the same review comment twice.
---

# /adr:guard — Install write-time + commit-time hooks

Use when the user wants the bot to enforce their team's principles automatically, not just on demand.

## Step 0 — Check principles exist

If `.adr/principles.json` doesn't exist:

> Your team principles haven't been discovered yet. Run `/adr:principles` first — the hooks need somewhere to read the rules from.

Stop.

## Step 1 — Install the hooks

```bash
adr guard install
```

This writes two files:

- `.claude/settings.local.json` — adds a PreToolUse hook on Edit/Write/MultiEdit. Every time Claude Code is about to write to a file, the hook checks the team principles for that file's path and injects the relevant ones into the agent's context. No LLM call — pure file-based lookup.
- `.git/hooks/pre-commit` — runs `adr review --staged --top-n 5` before each commit. Blocks the commit if any HIGH-severity violation is found; lets medium/low through as advisory.

Both installs are idempotent — running again is a no-op.

## Step 2 — Show the user what's now in effect

> The hooks are installed. From now on:
>
> - **At write time**, every Edit/Write tool call shows me the team principles for that file's area. I'll surface conflicts if the change would violate one.
> - **At commit time**, `git commit` runs an automatic check. HIGH-severity violations block the commit. Bypass with `git commit --no-verify` if you must.

## Step 3 — Offer the dry-run

> Want to test it? Tell me to edit a file in this repo and I'll show you the principles that fire.

## Notes for the bot

- **The pre-write hook is silent when no principles match.** That's intentional — write-time noise on every Edit kills the signal. Only fires when a discovered example shares a top-level dir with the edited file, or the lens is broadly applicable.
- **Re-run `adr guard install` to refresh.** Principles can change (re-running `/adr:principles` updates them); the install command is idempotent so re-running is safe.
- **Pre-commit failures are recoverable.** If the user hits a block they disagree with, they can either (a) fix the issue, (b) update the principle via `/adr:principles`, or (c) bypass with `--no-verify` for an emergency commit.
