# Crystal Ball — v0 scaffold

> The thinking, not the transcript.

Publish your current Claude Code session as a **capsule**. Anyone with the
link can ask it questions — it answers in your voice, with the full session
as context. Visitors don't need access to your AI, your codebase, or your
chat history.

## Two ways to publish

### A. `/crystal:publish` (recommended)

Inside any Claude Code session, run:

```
/crystal:publish
```

The skill (`crystal-ball/plugin/commands/publish.md`) finds the active
session's `.jsonl`, POSTs it to your local Crystal Ball server, and prints
the share URL. Zero friction.

### B. Drag-drop on the web UI

Open <http://localhost:5273>, drop a `.jsonl` file. Same result — useful
for republishing an archived session or importing a non-Claude-Code source.

## Run locally

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # required for visitor chat
npm run crystal:server                # API on :5274
npm run crystal:dev                   # web on :5273
```

Then either drop a file on `localhost:5273`, or run `/crystal:publish` in a
Claude Code session.

## Env vars

| var | default | meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required for chat) | passed straight to Anthropic SDK |
| `CRYSTAL_BALL_MODEL` | `claude-sonnet-4-5` | model used for visitor chat |
| `CRYSTAL_BALL_MAX_TOKENS` | `1024` | per-reply token cap |
| `CRYSTAL_VIEWER_URL` | `http://localhost:5273` | what the server bakes into share URLs |
| `CRYSTAL_BALL_SERVER_URL` | `http://127.0.0.1:5274` | where the `/crystal:publish` skill POSTs |
| `PORT` | `5274` | server port |

## What's in v0

- **Skill** (`plugin/commands/publish.md`) — `/crystal:publish` captures the
  current Claude Code session and publishes it.
- **Server** (`server.mjs`) — three endpoints:
  - `POST /api/capsules` — parse + store capsule
  - `GET /api/capsules/:id` — fetch capsule
  - `POST /api/chat` — visitor chat (stance-inheritance)
- **Web viewer** (Vite + React + react-three-fiber):
  - Fullbleed 3D crystal whose visual params are derived from the session
    (size from message count, hue from topic, cracks from failed tool calls,
    glow from outcome).
  - Drag-drop importer.
  - Glass-overlay chat box for visitors.
- **Storage** — local filesystem at `crystal-ball/.capsules/<id>.json`,
  gitignored. No auth, no accounts, no expiration. v0 demo only.

## What's deliberately NOT here

- No auto-redaction. Publisher is responsible for what's in the session.
- No crystal-to-crystal interaction.
- No accounts, no auth, no team scoping.
- No incremental updates (capsules are immutable — republish for v2).
- No hosted deployment story — server runs on your laptop.

## Architecture decisions

See [`docs/capsule-schema.md`](./docs/capsule-schema.md) for the durable
schema. Importers (`src/lib/parser.js`) and the visitor chat both consume
this shape, so future Cursor / ChatGPT / Aider importers plug in without
touching the viewer or chat.
