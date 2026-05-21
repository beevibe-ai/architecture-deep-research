# Framework Adapters

ADR keeps the artifact kernel framework-neutral, then exposes real adapter entry points for production orchestration frameworks.

## LangGraph

The LangGraph adapter lives in:

```text
adapters/langgraph.mjs
```

It uses:

- `StateGraph`
- `START`
- `END`
- `MemorySaver`

The graph is intentionally small:

```text
START
  -> run_adr_deep_research_kernel
  -> load_execution_handoff
  -> END
```

This gives LangGraph ownership of orchestration/checkpointing while ADR still owns the Strategic Context Model, evidence preservation, artifact validation, and Execution Handoff boundary.

Run:

```bash
npm run adr:langgraph -- examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out /tmp/adr-langgraph-output
```

Programmatic use:

```js
import { runLangGraphDeepResearch } from "./adapters/langgraph.mjs";

await runLangGraphDeepResearch({
  inputPath: "examples/logistics-contract-mesh/product-context.md",
  domain: "global logistics contract analysis",
  decision: "retrieval topology",
  outDir: "/tmp/adr-langgraph-output",
  flags: { "max-cycles": "2", "max-sources": "4" },
  threadId: "adr-demo"
});
```

## Google ADK

There are two complementary Google ADK adapters.

### Tool Wrapper Adapter

```text
adapters/google-adk.mjs
```

Wraps the kernel's `deepResearch` as an `Agent` + `FunctionTool` so the existing pipeline (with whatever LLM provider is configured via env) can be embedded inside an ADK multi-agent system.

- Tool: `run_architecture_deep_research`
- Agent factory: `createArchitectureDeepResearchAgent`
- Default export: `rootAgent`

```js
import {
  createArchitectureDeepResearchAgent,
  createArchitectureDeepResearchTool
} from "./adapters/google-adk.mjs";

const agent = createArchitectureDeepResearchAgent();
const tool = createArchitectureDeepResearchTool();
```

### Gemini-as-LLM-Provider Adapter

```text
adapters/google-adk-deep-research.mjs
```

Installs Gemini (via `@google/adk`) as the kernel's LLM backend, so the entire live-agentic loop — planner, claim extraction, synthesis, evaluation pack — runs through Gemini instead of an OpenAI-compatible API. The kernel still owns orchestration, evidence preservation, knowledge-map gating, and the Execution Handoff boundary.

The integration point is `setLlmJsonProvider` on the kernel: the ADK adapter constructs an `LlmAgent` per JSON call with `responseMimeType: "application/json"`, runs it via `InMemoryRunner.runEphemeral`, and parses the result. Every existing kernel invariant (no offline, no static pattern library, evidence-only candidate promotion, `requires_human_architecture_review` fallback when evidence is weak) is preserved.

CLI:

```bash
npm run adr:adk -- examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/adk-logistics-contract-mesh \
  --max-cycles 2
```

Required env:

- `GEMINI_API_KEY` or `GOOGLE_GENAI_API_KEY` (or `GOOGLE_API_KEY`)
- one live search provider: `BRAVE_SEARCH_API_KEY`, `SERPER_API_KEY`, `TAVILY_API_KEY`, or `SEARXNG_URL`

Optional env: `ADR_ADK_MODEL` (default `gemini-2.5-flash`).

Programmatic use:

```js
import {
  createAdkDeepResearchAgent,
  createAdkDeepResearchTool,
  runAdkDeepResearch
} from "./adapters/google-adk.mjs";

await runAdkDeepResearch({
  inputPath: "examples/logistics-contract-mesh/product-context.md",
  domain: "global logistics contract analysis",
  decision: "retrieval topology",
  outDir: ".adr-runs/adk-logistics-contract-mesh"
});
```

Or use the JSON provider directly with the kernel's `deepResearch`:

```js
import { deepResearch, setLlmJsonProvider } from "@beevibe/architecture-deep-research";
import { createAdkJsonProvider } from "@beevibe/architecture-deep-research/adapters/google-adk-deep-research";

setLlmJsonProvider(createAdkJsonProvider({ model: "gemini-2.5-pro" }), {
  label: "adk-gemini:pro"
});

await deepResearch({ inputPath, flags: { domain, decision, out: outDir } });
```

The agent instruction preserves the product boundary:

```text
Stop at Execution Handoff; never implement the downstream product.
```

## Beevibe

The Beevibe adapter lives in:

```text
adapters/beevibe.mjs
```

It turns completed ADR artifacts into a mesh handoff that an Architect specialist can pass to IC coding agents.

```js
import { createBeevibeMeshHandoff } from "./adapters/beevibe.mjs";

const handoff = await createBeevibeMeshHandoff({
  outDir: ".adr-runs/logistics-contract-mesh"
});
```

See [beevibe-integration.md](./beevibe-integration.md).

## Smoke Test

```bash
npm run smoke:frameworks
```

This test verifies adapter shape only. It does not run fake research without live credentials.

- the LangGraph adapter exports the deep research runner;
- the Google ADK tool-wrapper adapter can construct an agent with the ADR function tool;
- the Google ADK Gemini-as-provider adapter exports `createAdkJsonProvider`, `createAdkDeepResearchAgent`, and `createAdkDeepResearchTool`, and the kernel's `setLlmJsonProvider` / `getLlmJsonProvider` / `activeLlmProvider` hooks correctly install and report a custom provider label;
- framework packages load without coupling the kernel to one orchestrator.

## Dependency Notes

Current runtime integrations:

- `@langchain/langgraph`
- `@google/adk`

These are optional peer dependencies and dev dependencies in this repo. The ADR kernel remains callable without installing either framework in downstream deployments. Install the framework only when you use its adapter:

```bash
npm install @langchain/langgraph
npm install @google/adk
```

`npm audit --omit=dev` should stay clean for the framework-neutral ADR kernel.
