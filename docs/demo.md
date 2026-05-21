# Public Demo

The demo is a real live Architecture Deep Research run over the logistics contract mesh example.

It requires:

```bash
export BRAVE_SEARCH_API_KEY=...
export ADR_OPENAI_API_KEY=...
```

Run:

```bash
npm run demo
```

Artifacts are written to:

```text
.adr-runs/demo/logistics-contract-mesh/
```

The demo intentionally fails without credentials. A deterministic mock would show the artifact shape, but it would not prove the product wedge: live agentic research for system design.
