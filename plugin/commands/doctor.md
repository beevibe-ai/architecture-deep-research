---
description: Audit the ADR environment and (optionally) walk the user through setting up API keys persistently. Use when the user asks "is ADR ready?", "what keys do I need?", or "set up ADR".
---

# /adr:doctor — Environment audit + setup

The doctor lives in the npm package, fetched on demand via `npx`. No global install needed.

## Step 1 — Audit

Run the audit to see what's present and what's missing:

```bash
npx -y --package=github:beevibe-ai/architecture-deep-research adr-doctor
```

The output lists every required and optional key, marks which are set and where (env vs `~/.adr/config.json`), and ends with READY or NOT READY.

## Step 2 — If NOT READY, offer setup

If the user agrees, run the interactive setup:

```bash
npx -y --package=github:beevibe-ai/architecture-deep-research adr-doctor setup
```

It will prompt for:

- One search provider (Brave / Tavily / Serper / SearXNG) — at least one required
- One LLM provider (`ADR_OPENAI_API_KEY` or `OPENAI_API_KEY`) — at least one required
- Optionally `GITHUB_TOKEN` (recommended — lifts the GitHub API rate limit) and `ADR_MODEL`

Keys are written to `~/.adr/config.json` (mode 0600). The MCP server loads them on startup, so the user does not need to remember to export anything in the shell that launches Claude Code.

## Step 3 — Re-audit

After setup, re-run the audit command from Step 1 to confirm READY.

## Notes

- Process env always wins over the config file. Users can override a single key for a single run by setting it inline (`OPENAI_API_KEY=... npx ...`).
- The config file stays local to the machine. It is not synced anywhere by this plugin.
- `npx -y --package=github:beevibe-ai/architecture-deep-research` caches after the first run. Subsequent invocations are fast.
