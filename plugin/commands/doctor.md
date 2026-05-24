---
description: Audit the ADR environment and (if anything is missing) walk the user through setting up API keys persistently. Use when the user asks "is ADR ready?", "what keys do I need?", "set up ADR".
---

# /adr:doctor — Environment audit + setup

The doctor lives in the npm package, fetched on demand via `npx`. No global install needed.

## Step 1 — Audit

Run the audit. It is read-only and never blocks on input:

```bash
npx -y --package=github:beevibe-ai/architecture-deep-research adr-doctor
```

The output lists every required and optional key, marks which are set and where (env vs `~/.adr/config.json`), and ends with READY or NOT READY.

**If READY**, tell the user and stop. They are done.

**If NOT READY**, proceed to Step 2.

## Step 2 — Ask the user for the missing keys

The doctor's interactive `setup` mode does NOT work inside Claude Code (no TTY when invoked through Bash). Instead, ask the user in chat for the keys we need, then write them with the non-interactive `set` command.

Use `AskUserQuestion` to collect the missing keys. Always offer "skip" so the user can decline optional ones.

### Required: search provider (need at least one)

If no search key is set, ask the user which provider they want to use. Options:

- **Brave Search** (`BRAVE_SEARCH_API_KEY`) — https://api-dashboard.search.brave.com (~2k queries/month free)
- **Tavily** (`TAVILY_API_KEY`) — https://tavily.com (1k requests/month free)
- **Serper** (`SERPER_API_KEY`) — https://serper.dev (2.5k queries on signup)
- **Self-hosted SearXNG** (`SEARXNG_URL`) — set the base URL of your instance
- **Skip — use OpenAI's hosted web_search fallback** (only works if `ADR_OPENAI_API_KEY` is set too)

Once they pick, ask them to paste the value in chat.

### Required: LLM provider (need at least one)

If no LLM key is set, ask for either:

- `ADR_OPENAI_API_KEY` (preferred name)
- `OPENAI_API_KEY` (fallback)

Same key — either name works. Get it from https://platform.openai.com/api-keys.

### Optional: recommended

- `GITHUB_TOKEN` — strongly recommended. Without it, the GitHub API caps at 60 calls/hour and multi-repo research runs hit it. Get a fine-grained token (read-only public_repo) at https://github.com/settings/tokens.
- `ADR_MODEL` — override the default `gpt-4.1-mini`. Skip unless the user wants a different model.

## Step 3 — Write the keys (non-interactive)

Call `adr-doctor set --json` with whatever the user gave you. Use a single JSON object so it's one bash invocation:

```bash
npx -y --package=github:beevibe-ai/architecture-deep-research adr-doctor set --json '{
  "BRAVE_SEARCH_API_KEY": "<user-provided>",
  "ADR_OPENAI_API_KEY":   "<user-provided>",
  "GITHUB_TOKEN":         "<user-provided>"
}'
```

Only include keys the user actually provided. The `set` command refuses unknown keys and rejects empty values.

If the user declined an optional key, omit it from the JSON — don't pass an empty string.

## Step 4 — Confirm READY

Re-run the audit:

```bash
npx -y --package=github:beevibe-ai/architecture-deep-research adr-doctor
```

The output should now end with READY. If it still says NOT READY, list what's still missing and loop back to Step 2 for those.

## Notes

- The config file at `~/.adr/config.json` has mode 0600 (only you can read it).
- Process env always wins over the file. Users can override a key for one invocation: `OPENAI_API_KEY=other-key adr ...`.
- `npx -y --package=github:beevibe-ai/architecture-deep-research` caches after the first call. Re-invocations are fast.
- For users who DO have a real terminal, `npx -y --package=github:beevibe-ai/architecture-deep-research adr-doctor setup` is the interactive equivalent. The slash command can't drive it because Bash inside Claude Code has no TTY.
