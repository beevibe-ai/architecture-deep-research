# ADR Studio — Architecture Canvas

A production multi-view system-design tool that runs as a VS Code extension. You
shape a design by dragging typed components, modeling data, and sketching flows —
or by talking to a streaming AI assistant that edits every view through tools.
The design compiles to `architecture.spec.json` + `plan.md` +
`execution-handoff.json`, the artifacts the `adr` pipeline already hands to
coding agents.

Blank-canvas-first: you start from nothing. The IR is generated from what you
draw and say, not seeded from a research run.

## Three cross-referenced views

- **Architecture** — components (service / datastore / queue / gateway / client /
  external) wired with typed protocols.
- **Data model** — entities with typed fields (PK/FK), relations with cardinality.
  An entity can be *owned by* a component (a cross-reference — the unification layer).
- **Flows** — multiple flowcharts of start / process / decision / end steps.

Live constraint lint runs across all three: a forbidden edge, a keyless entity,
an orphaned step glows red and the assistant can explain or fix it.

## The dock

- **Assistant** — streaming AI that edits the IR through view-namespaced tools
  (`arch_*`, `dm_*`, `flow_*`, `scaffold_subsystem`, `write_plan_section`). Every
  edit animates the canvas live; the model sees lint feedback and self-corrects.
- **IR JSON** — the live `architecture.spec.json`.
- **Plan** — the generated `plan.md` (deterministic tables + Mermaid from the IR,
  AI prose spliced in). “Write plan.md” persists it.

Undo/redo (`Cmd/Ctrl+Z`, `+Shift`) and external file-watch (edit the spec on disk
or `git pull` and the canvas reloads) are built in.

## Layout

```
studio/
  host/          extension host (bundled to out/extension.js by esbuild)
    extension.js   command, webview panel, spec I/O, file-watch, schema validate
    chat.mjs       streaming assistant — Anthropic tool-calls -> IR edits
    schema.mjs     ajv schema, validate-on-read
  shared/        one source of truth, imported by host AND webview
    ir.mjs         multi-view IR: views{architecture,data_model,flows}, applyMutation, migrate
    constraints.mjs per-view lint + view-keyed violationIndex
    plan.mjs       deterministic plan.md + relaxed Mermaid validator
    handoff.mjs    compile -> execution-handoff.json
    *.test.mjs     node --test (pure)
  webview/       React + React Flow (Vite -> dist/)
    src/views/*    ArchitectureView, DataModelView, FlowsView + custom nodes
    src/RightDock, IrJsonPanel, PlanPanel
```

The **same `applyMutation` path** handles a drag-drop edit and an assistant
tool-call across every view, so the surfaces can never diverge.

## Install (normal use)

```bash
cd studio
npm install
npm run package                       # build webview + bundle host + vsce package
code --install-extension adr-studio-0.1.0.vsix
```

Then in any VS Code window: open a folder → `Cmd+Shift+P` → **ADR Studio: Open
Architecture Canvas**. The design saves to `.adr/architecture.spec.json` in that
folder.

The assistant can run on Anthropic, OpenAI, OpenRouter, Groq, Together AI,
DeepSeek, or a custom OpenAI-compatible endpoint. Run **ADR Studio: Set LLM API
Key** to store a key in VS Code SecretStorage, or provide the matching env var:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`
- `GROQ_API_KEY`
- `TOGETHER_API_KEY`
- `DEEPSEEK_API_KEY`
- `OPENAI_COMPATIBLE_API_KEY`

Drag-and-drop editing works keyless.

## Develop

Open this repo in VS Code and press **F5** (a `preLaunchTask` builds the webview
and bundles the host). Or build manually:

```bash
npm run build --prefix studio         # webview (dist/) + host bundle (out/)
npm test --prefix studio              # node --test, shared + host
```

## Config

| Setting | Default | Meaning |
| --- | --- | --- |
| `adrStudio.specPath` | `.adr/architecture.spec.json` | where the design is read/written |
| `adrStudio.provider` | `anthropic` | active LLM provider |
| `adrStudio.model` | `claude-sonnet-4-6` | Anthropic model |
| `adrStudio.openaiModel` | `gpt-4o` | OpenAI model |
| `adrStudio.openrouterModel` | `openrouter/auto` | OpenRouter model |
| `adrStudio.groqModel` | `llama-3.3-70b-versatile` | Groq model |
| `adrStudio.togetherModel` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | Together AI model |
| `adrStudio.deepseekModel` | `deepseek-v4-flash` | DeepSeek model |
| `adrStudio.openaiCompatibleBaseUrl` | empty | custom OpenAI-compatible base URL |
| `adrStudio.openaiCompatibleModel` | `gpt-4o-mini` | custom OpenAI-compatible model |
| `adrStudio.repoPath` | empty | repo scanned by “Scan repo”; empty means the open workspace |
