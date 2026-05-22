# Benchmarks

ADR benchmarks are live architecture-decision experiments. They require real web search and real LLM synthesis.

They do not benchmark generated application code. They score whether the ADR agent:

- chooses an acceptable architecture family;
- rejects tempting but unsafe alternatives;
- preserves required domain invariants;
- generates useful evaluation test types;
- stops at Execution Handoff;
- asks for clarification when context is insufficient.

## Runtime Requirements

Set one search provider:

```bash
export BRAVE_SEARCH_API_KEY=...
# or SERPER_API_KEY / TAVILY_API_KEY / SEARXNG_URL
```

Set one OpenAI-compatible LLM provider:

```bash
export ADR_OPENAI_API_KEY=...
export ADR_MODEL=gpt-4.1-mini
```

## Run

```bash
npm run benchmark:live
```

Fast pass:

```bash
npm run benchmark:live:fast
```

The benchmark fails fast if credentials are missing. This is intentional: a fake offline run would not test Architecture Deep Research.

Frozen local regression pass:

```bash
npm run benchmark:replay
```

This is not a production research run. It replays synthetic kernel failure modes so CI can verify evidence promotion, hard-gated synthesis, citation-audit downgrade, and schema-valid artifact writing without network access.

## Case Format

Each case directory contains:

```text
product-context.md
case.json
```

`case.json` defines the expected architecture family, forbidden topology IDs, required invariant substrings, expected evaluation test types, and clarification expectation.

## Output

Runs are written to:

```text
.adr-runs/benchmarks/live/latest/
```

Each case gets a full ADR output directory under:

```text
.adr-runs/benchmarks/live/latest/cases/<case-id>/
```

Outputs are ignored by Git.
