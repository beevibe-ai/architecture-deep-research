---
description: Set up ADR for first-time use. Audits what's already configured, then walks the user through obtaining and saving the API keys ADR needs. Use when the user asks "set up ADR", "what keys do I need?", "I don't know how to get these", or when /adr:decide reports missing keys.
---

# /adr:doctor — First-time setup

**Audience: someone who may have never created an API key before.** Do not paste URLs and walk away. Open each signup page in their browser, then guide them through the click path one step at a time. Wait for them to come back with each value before moving on.

## Step 1 — Audit what's already there

```bash
npx -y --package=github:beevibe-ai/beevibe-cto adr-doctor
```

Read the output:

- If it ends with **READY**, congratulate the user and stop. They're done.
- If it ends with **NOT READY**, note which keys are missing and proceed to Step 2. Skip any category that's already set.

## Step 2 — Walk through each missing key

For each missing key, do three things in this order:

1. Explain in one sentence what it's for and what the user is about to do.
2. Open the signup page in their browser via `open <url>` (macOS) or print the URL with instructions to click (other OSes).
3. Walk them through the navigation, step by step. Wait for them to paste the value into chat before moving on.

### Search provider (required)

**Ask the user which provider they want before opening anything.** Use `AskUserQuestion` with this exact question and options — do not pick for them:

> Question: "Which search provider would you like ADR to use? It pulls live evidence from the web for every research run."
>
> Options:
> - **Brave Search (recommended)** — 2,000 free queries/month, no credit card required
> - **Tavily** — 1,000 free requests/month, no credit card required
> - **Serper (Google)** — 2,500 free queries on signup
> - **Self-hosted SearXNG** — already running your own instance

Then dispatch by their choice. Each branch: open the signup page, walk through the click path, capture the key.

#### If they pick Brave Search

```bash
open https://api-dashboard.search.brave.com/register 2>/dev/null || echo "Open this URL in your browser: https://api-dashboard.search.brave.com/register"
```

> 1. Sign in with Google or GitHub (top-right).
> 2. Click **Subscribe** in the left sidebar, pick the **Free** plan.
> 3. Click **Add API key**, name it "adr".
> 4. Copy the key value (a long random string).
>
> Paste it here when you have it.

Capture as `BRAVE_SEARCH_API_KEY`.

#### If they pick Tavily

```bash
open https://app.tavily.com/home 2>/dev/null || echo "Open this URL in your browser: https://app.tavily.com/home"
```

> 1. Sign in (Google / GitHub / email).
> 2. The dashboard shows your API key at the top — it starts with `tvly-`.
> 3. Click the copy icon next to it.
>
> Paste the key here.

Capture as `TAVILY_API_KEY`.

#### If they pick Serper

```bash
open https://serper.dev/api-key 2>/dev/null || echo "Open this URL in your browser: https://serper.dev/api-key"
```

> 1. Sign in (Google / GitHub).
> 2. Your API key is shown on the page — copy it.
>
> Paste the key here.

Capture as `SERPER_API_KEY`.

#### If they pick Self-hosted SearXNG

Don't open a URL. Just ask:

> Paste the base URL of your SearXNG instance (e.g. `https://search.example.com`).

Capture as `SEARXNG_URL`.

### LLM provider (required) → **OpenAI**

Say:

> ADR uses an LLM to synthesize the research. I'll set up OpenAI. New accounts get $5 in free credits — enough for many ADR runs. After that you'll need to add a credit card. Opening the keys page now.

Then:

```bash
open https://platform.openai.com/api-keys 2>/dev/null || echo "Open this URL: https://platform.openai.com/api-keys"
```

Walk them through:

> 1. Sign in (or create an account at https://platform.openai.com/signup if you don't have one).
> 2. Click **Create new secret key** (top-right).
> 3. Name it "adr" — leave permissions on "All".
> 4. Click **Create secret key** and copy the value. It starts with `sk-`. **You can only see it once** — copy it now.
>
> Paste the key here.

Capture as `ADR_OPENAI_API_KEY`.

If they don't want to create an OpenAI account, they can use any OpenAI-compatible provider (Azure, vLLM, llamafile, Ollama with OpenAI wrapper). Set `ADR_OPENAI_BASE_URL` to point at it. But for first-time users, just use OpenAI.

### GitHub token (optional but strongly recommended)

Say:

> Without a GitHub token, ADR is capped at 60 GitHub API calls per hour. Multi-repo research runs hit that fast. With a token, the cap is 5,000/hr. The token is free and takes 30 seconds. Want to set one up?

If yes:

```bash
open "https://github.com/settings/personal-access-tokens/new" 2>/dev/null || echo "Open this URL: https://github.com/settings/personal-access-tokens/new"
```

Walk them through:

> 1. **Token name**: "adr"
> 2. **Expiration**: 90 days (or "No expiration" if you don't want to renew)
> 3. **Repository access**: "Public Repositories (read-only)" — that's enough.
> 4. **Permissions**: leave defaults (Contents read, Metadata read).
> 5. Click **Generate token** at the bottom. Copy the value — starts with `github_pat_`.
>
> Paste the token here.

Capture as `GITHUB_TOKEN`. If they decline, skip.

### Model override (optional — only if they ask)

Don't bring this up unless the user asks about it. Default `gpt-4.1-mini` is fine for most decisions. Smarter alternative: `gpt-5` (slower, more expensive, better synthesis).

## Step 3 — Write the keys in one bash call

```bash
npx -y --package=github:beevibe-ai/beevibe-cto adr-doctor set --json '{
  "BRAVE_SEARCH_API_KEY": "<paste-from-step-2>",
  "ADR_OPENAI_API_KEY":   "<paste-from-step-2>",
  "GITHUB_TOKEN":         "<paste-from-step-2>"
}'
```

**Only include keys the user actually provided.** If they skipped `GITHUB_TOKEN`, omit it entirely from the JSON — don't pass `""`.

The `set` command writes to `~/.adr/config.json` (mode 0600), refuses unknown keys, and re-audits at the end.

## Step 4 — Confirm READY

The previous step's output already shows the post-write audit. It should end with **READY**.

If it still says NOT READY, identify what's still missing and loop back to Step 2 for those specific keys.

## Closing message

Once READY, tell the user:

> You're all set. Try `/adr:decide` to make an architecture decision against the current repo, or `/adr:discover` for a quick scan-only preview.

## Notes for Claude

- **Be patient.** A first-time user creating an OpenAI account from scratch can take 5+ minutes (signup → email verification → phone verification → page navigation). Don't rush them.
- **Don't echo keys back.** When the user pastes a key, acknowledge ("got it") and move on. Don't repeat the value.
- **One key at a time.** Don't ask for all three keys in one message. Walk through each one fully (open URL, give steps, wait for paste) before starting the next.
- **If the user gets lost**, offer to screenshot-walk them through it: "if you're stuck, tell me what you see and I'll guide you."
- **Mask in your own messages.** Refer to keys as "the Brave key you just gave me", not by value.
- Keys are persisted to `~/.adr/config.json`. The user never needs to re-export them in a shell.
