# ADR Studio — Architecture Canvas

A drag-and-drop system-architecture canvas with an AI design assistant, running
as a VS Code webview. You shape a design by dragging typed components and talking
to the assistant; the design compiles to `architecture.spec.json` +
`execution-handoff.json` — the same artifacts the `adr` pipeline already hands to
coding agents.

Blank-canvas-first: you start from nothing and build up. The IR is generated from
what you draw, not seeded from a research run.

## What's here

```
studio/
  host/            VS Code extension host (CJS)
    extension.js     command, webview panel, spec file I/O, message bridge
    chat.mjs         design-assistant loop — Anthropic tool-calls -> IR edits
  shared/          one source of truth, imported by host AND webview
    ir.mjs           the topology IR: nodes, edges, applyMutation
    constraints.mjs  the live lint engine (forbid_edge, require_protocol, …)
    handoff.mjs      compile a design -> execution-handoff.json
    ir.test.mjs      core unit tests (node --test)
  webview/         React + React Flow canvas (Vite)
    src/Canvas.jsx   the drag-drop graph + inspector
    src/Palette.jsx  component drag source
    src/ChatSidebar.jsx  the assistant + violation list
```

The **same `applyMutation` path** handles both a drag-drop edit and an assistant
tool-call, so the two surfaces can never diverge.

## The IR

One `topology` block added to `architecture.spec.json`:

```jsonc
"topology": {
  "nodes": [{ "id": "service_1", "kind": "service", "label": "API",
              "tech": "Express", "context": "", "notes": "",
              "position": { "x": 240, "y": 120 } }],
  "edges": [{ "id": "e_2", "from": "service_1", "to": "datastore_1",
              "kind": "calls", "protocol": "sql", "label": "" }]
},
"constraints": [{ "id": "no-direct-client-db", "rule": "forbid_edge",
                  "from_kind": "client", "to_kind": "datastore",
                  "message": "Clients must not touch a datastore directly." }]
```

`constraints` are machine-checkable and evaluated live — a violating edge glows
red and the assistant can explain it. That's the part Figma / plain React Flow
can't do, and the part coding agents actually need at handoff.

## Run it

```bash
# from the repo root — installs are already hoisted there
npm run build --prefix studio      # build the webview into studio/dist
```

Then in VS Code: open this repo, press **F5** (uses `studio/.vscode/launch.json`),
and in the dev host run **ADR Studio: Open Architecture Canvas** from the command
palette.

The assistant needs an Anthropic key — `ANTHROPIC_API_KEY` in the env or the one
`adr-doctor setup` persists to `~/.adr/config.json`. Drag-and-drop editing works
without a key.

## Config

| Setting | Default | Meaning |
| --- | --- | --- |
| `adrStudio.specPath` | `.adr/architecture.spec.json` | where the design is read/written |
| `adrStudio.model` | `claude-sonnet-4-6` | model the assistant uses |

## Test

```bash
node --test studio/shared/ir.test.mjs
```
