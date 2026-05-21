# Web UI

ADR ships a single web app with two modes, both reading the kernel's existing artifacts on disk:

- **Operator mode** — Onyx-style, product-facing. Plan card, comparison matrix, evidence panel, decision card with rationale + rejected alternatives, run-quality sidebar.
- **Developer mode** — Google ADK Dev UI-style, observability-facing. Live event timeline tailed from `events.jsonl`, JSON inspector for every event, per-artifact JSON browser, run state snapshot.

Toggle in the run detail header. The same backend, the same artifacts.

## Why two modes

ADR runs produce both a user-facing decision (what topology did we pick and why) and a developer-facing trace (every search, claim extraction, judge call, critique issue, citation verdict). One audience wants a clean decision card and a colored comparison matrix; the other audience wants the raw event stream and JSON. Two UIs would duplicate the artifact-loading code, so they share a single app.

## Running the UI

```bash
# 1. Build the UI once (or after changes)
npm run web:build

# 2. Start the server pointing at a runs directory
npm run adr:web -- --runs .adr-runs --port 4173

# Or open the browser automatically:
npm run adr:web -- --open
```

The server:

- Watches `.adr-runs/` (configurable via `--runs`)
- Serves built UI from `web/dist/` (configurable via `--dist`)
- Defaults to `http://127.0.0.1:4173`

### Dev mode (hot-reload)

```bash
# In one terminal:
npm run adr:web -- --port 4173

# In another:
npm run web:dev
```

`web:dev` runs Vite on port 5173 and proxies `/api/*` to the running adr-web server. Iterate on UI changes with hot reload; the server keeps serving artifacts.

## API surface

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness + runs dir |
| `GET /api/runs` | List all runs under `--runs` with summarized state |
| `GET /api/runs/:id` | Single run summary + available artifacts |
| `GET /api/runs/:id/artifact/:name` | Load one artifact (JSON parsed; `.jsonl` returned as `{ events: [...] }`; markdown as `{ markdown: "..." }`) |
| `GET /api/runs/:id/events` | Server-Sent Events tail of `events.jsonl`, including future events while the run is in progress |
| `POST /api/runs` | Spawn a new run via the existing CLI (`runtime: openai \| langgraph \| adk`, plus `inputPath`, `domain`, `decision`, `outDir`, optional `model`, optional `flags`) |

## Architecture

```
                ┌────────────────────────────────────────────────┐
                │  web/  (Vite + React + Tailwind, single SPA)    │
                │                                                │
                │  <App>                                          │
                │   ├─ RunsIndex     (multi-run dashboard)        │
                │   ├─ NewRunForm    (POST /api/runs)             │
                │   └─ RunDetail                                  │
                │       ├─ ModeToggle: Operator | Developer       │
                │       ├─ OperatorView   (DecisionCard,          │
                │       │                  ComparisonMatrix,      │
                │       │                  PlanCard, EvidencePanel│
                │       │                  QualityPanel)          │
                │       └─ DeveloperView  (EventTimeline + filter,│
                │                          JsonInspector,         │
                │                          ArtifactList)          │
                └─────────────────────┬──────────────────────────┘
                                      │  HTTP (REST + SSE)
                                      ▼
                ┌────────────────────────────────────────────────┐
                │  scripts/adr-web.mjs  (Node http.Server)        │
                │                                                │
                │  - lists runs from .adr-runs/                   │
                │  - reads artifacts on demand                    │
                │  - tails events.jsonl via fs.watch + SSE        │
                │  - spawns kernel CLIs for POST /api/runs        │
                └─────────────────────┬──────────────────────────┘
                                      │
                                      ▼
                ┌────────────────────────────────────────────────┐
                │  src/kernel.mjs                                 │
                │  scripts/adr.mjs / adr-langgraph.mjs /          │
                │    adr-adk.mjs (spawned as needed)              │
                └────────────────────────────────────────────────┘
```

No state lives in the UI server other than file descriptors for live event tails. The runs directory on disk is the source of truth.

## Operator mode breakdown

- **Decision card.** Selected topology in large type with its label. Original choice surfaced when critique downgraded the decision to `requires_human_architecture_review`. Rejected alternatives listed with fit summaries and risks.
- **Comparison matrix.** Rows = axes derived from the Strategic Context Matrix; columns = candidates. Each cell colored by verdict (`strong` / `mixed` / `weak` / `no_evidence`) with the LLM's one-line summary and the citation_ids it cited. Adversarial queries (if any) listed below.
- **Plan card.** Tasks with id, title, objective, search queries.
- **Evidence panel.** Grouped header showing promoted vs insufficient candidates, then each evidence item with source-type pill, repo or paper digest one-liner when applicable, and top claims tinted by polarity (supports/rejects/neutral).
- **Quality panel.** Run health at a glance — evidence count, matrix coverage, critique severity, citation audit verdicts.

## Developer mode breakdown

- **Event timeline.** Every event from `events.jsonl` rendered with timestamp, type pill, and one-line summary. Click any event to inspect its full JSON. Filter by text or event type.
- **JSON inspector.** Lazy-expanding tree view of arbitrary JSON. Collapses long strings, arrays, and objects after depth 2. Click to expand. Useful when you want to read a single research_round_judged event's exact LLM response.
- **Artifact browser.** All known JSON artifacts listed in canonical order. Select one to render it in the inspector.
- **Run state.** Live snapshot of `state.json`.

## Live-tail semantics

The server uses `fs.watch` on `events.jsonl` and `createReadStream` from the last known byte position. New lines are pushed to the connected SSE clients. Heartbeats every 15s keep the connection open through idle proxies. When the file does not exist yet (a run that just started writing artifacts), the SSE connection opens and waits for the first write.

## CLI

```
adr-web [--runs <dir>] [--port <n>] [--host <h>] [--dist <dir>] [--open]
```

Defaults: `--runs .adr-runs`, `--port 4173`, `--host 127.0.0.1`, `--dist web/dist`.

The server is a single `http.createServer` with no framework. Adding routes is a matter of extending the request handler.

## Smoke test

```bash
npm run smoke:web
```

Spawns the server on a non-standard port pointed at a temporary `.smoke-runs/` directory containing a synthesized completed run, exercises every API endpoint, asserts that the SPA fallback returns the built React shell when `web/dist/` exists, and cleans up.
