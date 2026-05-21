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

The Google ADK adapter lives in:

```text
adapters/google-adk.mjs
```

It uses:

- `Agent`
- `FunctionTool`

The exported ADK tool is:

```text
run_architecture_deep_research
```

The exported agent is:

```js
rootAgent
```

Programmatic use:

```js
import {
  createArchitectureDeepResearchAgent,
  createArchitectureDeepResearchTool
} from "./adapters/google-adk.mjs";

const agent = createArchitectureDeepResearchAgent();
const tool = createArchitectureDeepResearchTool();
```

The ADK agent instruction explicitly preserves the product boundary:

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
- the Google ADK adapter can construct an agent with the ADR function tool;
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
