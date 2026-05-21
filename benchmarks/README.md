# Benchmarks

ADR benchmarks measure the system at the architecture-decision layer.

They do not ask whether generated application code passes tests. They ask whether ADR:

- chooses the expected architecture family;
- rejects tempting but unsafe alternatives;
- preserves required domain invariants;
- generates useful evaluation test types;
- stops at Execution Handoff;
- asks for clarification when context is insufficient.

## Run

```bash
npm run benchmark
```

Strict mode:

```bash
npm run benchmark:ci
```

## Case Format

Each case directory contains:

```text
product-context.md
case.json
```

`case.json` defines:

- `domain`
- `decision`
- `expected.selected_topology`
- `expected.forbidden_topologies`
- `expected.required_invariant_substrings`
- `expected.evaluation_test_types`
- `expected.needs_clarification`

## Metrics

The offline benchmark uses weighted scoring:

- selected topology: 35%
- forbidden topology recall: 15%
- required invariant recall: 20%
- evaluation test coverage: 15%
- handoff boundary: 10%
- clarification correctness: 5%

The result is written to `.adr-runs/benchmarks/offline/latest/summary.json`.

## Experiment Outputs

Benchmark outputs are intentionally ignored by Git. They include full ADR artifacts for each case so failures can be inspected locally without polluting the repo history.
