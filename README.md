# Beevibe Architecture Deep Research

**Deep research for strategic system design.**

Architecture Deep Research, or **ADR**, is a Beevibe flagship project for answering the architecture question that coding agents still handle badly:

> Given this product, domain, data shape, compliance envelope, team maturity, and operating budget, which architecture family should we bet on before a coding agent writes the first file?

Coding agents are excellent execution engines. They edit files, run tests, and iterate quickly. The failure mode is one layer higher: they often choose the easiest local implementation path before they understand the architecture family the product actually needs.

ADR is the missing deep research layer for that decision.

## Product Boundary

ADR does not implement the downstream product.

It researches architecture choices, acquires live evidence, synthesizes a decision, generates an evaluation pack, and hands off constraints to execution agents.

```text
Product brief / PRD
        |
        v
Architecture Deep Research
        |
        +--> live source acquisition
        +--> claim extraction
        +--> evidence-only knowledge map
        +--> architecture synthesis
        +--> adversarial evaluation pack
        |
        v
Execution Handoff
```

The handoff is where ADR stops. Beevibe, Claude Code, Cursor, Codex, or another coding agent consumes the constraints afterward.

## Hard Rules

- No offline research mode.
- No deterministic mock research.
- No static pattern library that forces the answer.
- Architecture candidates must be acquired from live source evidence.
- If evidence is insufficient, ADR should say so instead of inventing confidence.

## Why Beevibe

ADR fits Beevibe naturally because Beevibe already has the primitives that an architecture researcher needs:

- A configured Architect agent can be represented as a normal `Agent` row at team or org level.
- Durable agent memory can store OSS precedents, DDD invariants, and failure-mode notes.
- The mesh provides the handoff path: IC coding agents escalate architecture decisions to the Architect specialist.
- Human review policy can require sign-off before implementation.
- Self-hosting keeps product architecture, PRDs, and internal constraints private.

ADR is not a separate bolt-on tool. It is the strategic architecture specialist inside the Beevibe agent mesh.

## Runtime Requirements

Every real ADR run requires live search and LLM synthesis.

Set one live search provider:

```bash
export BRAVE_SEARCH_API_KEY=...
# or SERPER_API_KEY / TAVILY_API_KEY / SEARXNG_URL
```

Set one OpenAI-compatible LLM provider:

```bash
export ADR_OPENAI_API_KEY=...
export ADR_MODEL=gpt-4.1-mini
```

Optional local/OpenAI-compatible server:

```bash
export ADR_OPENAI_BASE_URL=http://localhost:1234/v1
```

## Quick Start

```bash
npm install

npm run adr -- deep-research examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/logistics-contract-mesh \
  --max-cycles 2 \
  --max-sources 4
```

Outputs:

```text
ADR.md
architecture.spec.json
domain-evaluation-pack.json
agent-guardrails.md
execution-handoff.json
strategic-context.json
research-plan.json
evidence.json
knowledge-map.json
research-report.md
sources.md
events.jsonl
state.json
```

## What The Agent Produces

### `architecture.spec.json`

Machine-readable architecture state:

- selected topology;
- bounded contexts;
- domain invariants;
- rejected alternatives;
- required guardrails;
- evidence citations.

### `knowledge-map.json`

Evidence-only architecture knowledge acquired during the run:

- promoted candidates;
- insufficient-evidence candidates;
- source types;
- citation IDs;
- support/warning/rejection claims.

This is not a hand-authored pattern library. It is a provenance record.

### `domain-evaluation-pack.json`

Adversarial test cases for the selected architecture:

- lineage checks;
- boundary-spill checks;
- multi-hop checks;
- abstention checks;
- agentic drift checks;
- latency or SLA expectations when available.

### `execution-handoff.json`

The machine-readable boundary object consumed by downstream agents. It states that ADR stops at Execution Handoff and lists the artifacts implementation agents must obey.

## Superseding ADRs

If implementation evidence, drift reports, or new research invalidates the decision, create a superseding ADR:

```bash
npm run adr -- supersede .adr-runs/logistics-contract-mesh \
  --with ./new-product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/logistics-contract-mesh-v2 \
  --reason "New evidence changes the topology decision."
```

The new run writes `supersedes.json` and appends a supersession section to the ADR.

## Framework Adapters

ADR keeps the kernel framework-neutral and exposes adapters:

- `adapters/langgraph.mjs`
- `adapters/google-adk.mjs`
- `adapters/beevibe.mjs`

LangGraph:

```bash
npm run adr:langgraph -- examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/langgraph-logistics
```

Beevibe handoff:

```js
import { createBeevibeMeshHandoff } from "@beevibe/architecture-deep-research/adapters/beevibe";

const handoff = await createBeevibeMeshHandoff({
  outDir: ".adr-runs/logistics-contract-mesh"
});
```

## Benchmarks

Benchmarks are live agentic experiments. They require credentials and fail fast without them.

```bash
npm run benchmark:live:fast
npm run benchmark:live
```

Package tests are intentionally different:

```bash
npm test
```

`npm test` validates schemas and adapter wiring. It does not fake a deep research run.

## Repository Shape

```text
.
├── adapters/
│   ├── beevibe.mjs
│   ├── google-adk.mjs
│   └── langgraph.mjs
├── benchmarks/
│   ├── configs/
│   │   ├── live-fast.json
│   │   └── live.json
│   └── cases/
├── docs/
│   ├── deep-research-agent.md
│   ├── experiments.md
│   ├── framework-adapters.md
│   └── schemas/
├── examples/
│   └── logistics-contract-mesh/
├── scripts/
│   ├── adr.mjs
│   ├── adr-langgraph.mjs
│   ├── benchmark.mjs
│   ├── check-json.mjs
│   └── smoke-frameworks.mjs
└── src/
    └── kernel.mjs
```

## Status

This repo is the open-source core:

- live agentic research kernel;
- artifact schemas;
- framework adapters;
- benchmark harness;
- Beevibe mesh handoff adapter.

The commercial Beevibe surface can layer curated corpora, managed researcher agents, org-level memory, and team governance on top.
