# Crystal Ball — v0 scaffold

> The thinking, not the transcript.

Drop a Claude Code session file. Get a queryable capsule you can share —
visitors can ask it questions as if continuing the original conversation,
with the publisher's stance and full context.

## Run locally

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # required for visitor chat
npm run crystal:server                # API on :5274
npm run crystal:dev                   # web on :5273
```

Open <http://localhost:5273>, drop a `.jsonl`, or click **try the sample**.

## What's in v0

- Drop-zone importer for Claude Code `.jsonl` sessions (or any capsule JSON
  matching `docs/capsule-schema.md`).
- Crystal cover: a 3D crystal whose size / hue / surface / cracks / glow are
  derived from the session's stats.
- Timeline view: messages, tool calls, file diffs.
- Visitor chat: asks Anthropic on the server, with the capsule flattened
  into the system prompt. Replies in the publisher's voice.

## What's deliberately NOT here

- No capture (no CLI / hook) — v0 is importer-first.
- No accounts, no server-side persistence; capsules live in the browser.
- No crystal-to-crystal interaction.
- No automated redaction.

See `docs/capsule-schema.md` for the durable contract that future importers
(Cursor, ChatGPT export, etc.) plug into.
