# Benchmark And Experiment Environment

ADR experiments are live agentic research runs. They are intentionally not deterministic mocks.

## What We Measure

- Architecture family fit.
- Evidence quality and source diversity.
- Rejected alternatives.
- Required domain invariants.
- Evaluation-pack coverage.
- Execution Handoff integrity.
- Clarification behavior.

## Quick Start

```bash
export BRAVE_SEARCH_API_KEY=...
export ADR_OPENAI_API_KEY=...
export ADR_MODEL=gpt-4.1-mini

npm run benchmark:live:fast
```

Full live benchmark:

```bash
npm run benchmark:live
```

Package tests are separate:

```bash
npm test
```

`npm test` runs the frozen kernel replay checks, validates schemas, and verifies adapter/UI wiring. It does not pretend to perform production deep research without credentials.

Frozen local regression pass:

```bash
npm run benchmark:replay
```

This checks evidence-gate behavior, schema-valid artifact writing, citation-audit downgrade behavior, and LLM enum/value normalization without network access.

## Output

Runs are written to:

```text
.adr-runs/benchmarks/live/latest/
```

Each case gets a full ADR output directory:

```text
.adr-runs/benchmarks/live/latest/cases/<case-id>/
```

The aggregate report is:

```text
.adr-runs/benchmarks/live/latest/summary.json
.adr-runs/benchmarks/live/latest/summary.md
```

## Adding A Case

Create:

```text
benchmarks/cases/my-case/
  product-context.md
  case.json
```

Keep expected values focused on architecture-level behavior, not exact prose. A live research agent may phrase a topology differently, but it should still preserve the core decision, rejected alternatives, and invariants.

## Single Live Experiment

```bash
npm run adr -- deep-research ./my-prd.md \
  --domain "my domain" \
  --decision "retrieval topology" \
  --out .adr-runs/experiments/my-live-run \
  --max-cycles 2 \
  --max-sources 4
```

Keep `.adr-runs` outside Git.
