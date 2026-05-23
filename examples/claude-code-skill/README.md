# /adr Claude Code skill

A single-slash entry into the full Architecture Deep Research loop. Type `/adr` in Claude Code, name the decision, and the skill runs `discover-first` deep-research via the MCP server, returning a summarized handoff you can implement against.

## What's in this directory

- **SKILL.md** — the skill definition Claude Code reads. Copy to `~/.claude/skills/adr/SKILL.md`.
- **.mcp.json** — the MCP server registration. Either merge into your existing Claude Code MCP config, or copy to `.mcp.json` in the project you want to enable the skill in.

## One-time setup

1. Install the `adr-mcp` bin globally:

```bash
git clone https://github.com/beevibe-ai/architecture-deep-research.git
cd architecture-deep-research
npm install
npm link               # makes adr, adr-mcp, etc. globally callable
```

   (Once we publish to npm, this becomes `npm install -g @beevibe/architecture-deep-research`.)

2. Drop the skill into your Claude Code config:

```bash
mkdir -p ~/.claude/skills/adr
cp SKILL.md ~/.claude/skills/adr/SKILL.md
```

3. Register the MCP server with Claude Code. Either:

   **Project-level (one repo at a time)** — copy `.mcp.json` from this directory to the root of the repo you want to use ADR in. Claude Code picks it up automatically.

   **User-level (all repos)** — open `~/.claude/settings.json` and merge the `mcpServers` block from `.mcp.json` into it.

4. Export at least one search-provider key and one LLM-provider key in the shell that launches Claude Code:

```bash
export ADR_OPENAI_API_KEY=...      # or OPENAI_API_KEY
export BRAVE_SEARCH_API_KEY=...    # or TAVILY_API_KEY / SERPER_API_KEY / SEARXNG_URL
export GITHUB_TOKEN=...             # optional but recommended (lifts GitHub API rate limit)
```

5. Restart Claude Code so it picks up the skill and the MCP server.

## Use it

In any Claude Code session inside a repo:

```
/adr
```

Claude will ask you what decision you're making, then run discover-first deep-research in the background. After 3–6 minutes you get a summarized handoff and an offer to either inspect the full ADR or implement under the handoff contract.

## Use it without the skill

The MCP server works with any MCP-aware host even if you don't install the skill:

- **Cursor / Codex / Beevibe agents** — register the same `.mcp.json` block in their MCP config. The agent decides when to call `adr_discover` or `adr_deep_research`.
- **Claude Code chat without the skill** — just type "Run an architecture deep research for X" and the model will call `adr_deep_research` if the MCP server is registered.

## Use it without MCP at all

The CLI works standalone:

```bash
# scan only
adr discover --repo . --decision "event bus topology" --out .adr-runs/event-bus

# scan + full pipeline in one command
adr deep-research --discover-first --repo . --domain X --decision Y --out .adr-runs/Y
```

This is what the MCP server is calling under the hood.
