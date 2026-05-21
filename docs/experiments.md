# Benchmark And Experiment Environment

ADR experiments are built around the architecture-decision boundary.

The benchmark environment answers:

- Did ADR choose the expected architecture family?
- Did it reject unsafe tempting alternatives?
- Did it preserve domain invariants?
- Did it generate the expected evaluation test classes?
- Did it stop at Execution Handoff?
- Did it ask for clarification when context was insufficient?

## Quick Start

```bash
npm run benchmark
```

Strict mode for CI:

```bash
npm run benchmark:ci
```

Full test suite:

```bash
npm test
```

## Output

Runs are written to:

```text
.adr-runs/benchmarks/offline/latest/
```

Each case gets a full ADR output directory:

```text
.adr-runs/benchmarks/offline/latest/cases/<case-id>/
```

The aggregate report is:

```text
.adr-runs/benchmarks/offline/latest/summary.json
.adr-runs/benchmarks/offline/latest/summary.md
```

These outputs are ignored by Git.

## Cases

Initial cases:

- `logistics-contract-mesh`: high-audit multi-hop GraphRAG decision.
- `docs-support-knowledge-base`: low-latency docs/support search.
- `open-ended-market-research`: exploratory agentic research.
- `transactional-approval-workflow`: domain-model-first transactional workflow.

## Metrics

The offline config weights:

- selected topology: 35%
- forbidden topology recall: 15%
- required invariant recall: 20%
- evaluation test coverage: 15%
- handoff boundary: 10%
- clarification correctness: 5%

The benchmark is intentionally small and deterministic. It is a regression harness for the ADR kernel, not a public claim that architecture has a single ground-truth answer.

## Adding A Case

Create a new directory under `benchmarks/cases`:

```text
benchmarks/cases/my-case/
  product-context.md
  case.json
```

The `case.json` file should specify the expected topology, forbidden topology IDs, required invariant substrings, evaluation test types, and clarification expectation.

## Live Experiments

The default benchmark runs offline for determinism. For live research experiments, call the deep research CLI directly with search provider environment variables:

```bash
BRAVE_SEARCH_API_KEY=... npm run adr -- deep-research ./my-prd.md \
  --domain "my domain" \
  --decision "retrieval topology" \
  --out .adr-runs/experiments/my-live-run
```

Keep live experiment outputs outside Git.
