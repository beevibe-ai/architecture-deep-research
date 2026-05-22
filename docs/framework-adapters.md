# Framework Adapters

ADR keeps the artifact kernel framework-neutral, then exposes real adapter entry points for production orchestration frameworks.

## LangGraph

The LangGraph runtime lives in:

```text
adapters/langgraph.mjs
adapters/langgraph-llm.mjs
```

It owns orchestration, state, and checkpointing. The ADR kernel still owns the Strategic Context Model, evidence acquisition, the knowledge map, synthesis, and the Execution Handoff boundary — LangGraph just walks the kernel's phases as explicit graph nodes.

### Graph shape

```text
START
  -> prepare_run                  (strategic context + clarification)
       |
       +-- needs_clarification? --> END
       |
  -> plan_research                (research plan)
       |
       +-- --plan-approval flag set? --> interrupt() → resume with Command
       |
  -> execute_research             (search + claim extraction + adaptive gap-filling)
  -> synthesize_decision          (architecture spec)
  -> critique_decision            (find uncited claims, contradictions, weak evidence)
  -> verify_citations             (post-hoc per-citation verification)
  -> write_artifacts              (ADR.md, spec, eval pack, claim audit, guardrails, handoff, ...)
  -> END
```

Each node maps to an exported kernel phase function (`prepareRun`, `planResearchPhase`, `executeResearchPhase`, `synthesizeDecisionPhase`, `critiqueDecisionPhase`, `verifyCitationsPhase`, `writeRunArtifacts`). The graph is checkpointed with `MemorySaver`, so a run can pause and resume on the same `thread_id`.

### Human-in-the-loop plan approval

Pass `--plan-approval` (or `flags: { "plan-approval": true }` programmatically) to pause after the planner. The `plan_research` node calls LangGraph's `interrupt()`, persisting the plan to `research-plan.json` and returning control to the caller.

```js
import {
  Command,
  createAdrLangGraph,
  resumeLangGraphDeepResearch,
  runLangGraphDeepResearch
} from "./adapters/langgraph.mjs";

const graph = createAdrLangGraph();   // share between run + resume
const threadId = "adr-logistics-mesh-2026-05-21";

const first = await runLangGraphDeepResearch({
  graph,
  threadId,
  inputPath: "./product-context.md",
  domain: "global logistics contract analysis",
  decision: "retrieval topology",
  outDir: ".adr-runs/langgraph-logistics",
  flags: { "plan-approval": true }
});

// first.__interrupt__ contains the plan and resume instructions.
// Edit research-plan.json on disk if you want, then:

await resumeLangGraphDeepResearch({
  graph,
  threadId,
  resume: { action: "approve" }            // or "edit" + plan, or "abort"
});
```

`MemorySaver` lives for the lifetime of the Node process. For cross-process pause/resume, swap in a persistent checkpointer (`@langchain/langgraph-checkpoint-sqlite`, `@langchain/langgraph-checkpoint-postgres`) via the `checkpointer` option.

### LLM backend

The LangGraph runtime installs a LangChain `initChatModel`-backed JSON provider on the kernel before invoking the graph. The default model is `openai:gpt-4.1-mini`, overridable via `--model` or the `LANGGRAPH_LLM` env var. Any provider supported by LangChain's universal initializer works (OpenAI, Anthropic, Google, Bedrock, Mistral, Ollama, Groq, DeepSeek, ...) — install the relevant `@langchain/<provider>` package, then pass `provider:model` as the model string.

### CLI

```bash
npm run adr:langgraph -- examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/langgraph-logistics \
  --model openai:gpt-4.1-mini \
  --max-cycles 2
```

Required env:

- one live search provider: `BRAVE_SEARCH_API_KEY`, `SERPER_API_KEY`, `TAVILY_API_KEY`, or `SEARXNG_URL`
- the API key for the model in `--model` (for example `OPENAI_API_KEY`)

### Programmatic use

```js
import { runLangGraphDeepResearch } from "./adapters/langgraph.mjs";

await runLangGraphDeepResearch({
  inputPath: "examples/logistics-contract-mesh/product-context.md",
  domain: "global logistics contract analysis",
  decision: "retrieval topology",
  outDir: ".adr-runs/langgraph-logistics",
  flags: { "max-cycles": "2", "max-sources": "4" },
  model: "google-genai:gemini-2.5-flash",
  threadId: "adr-demo"
});
```

To use the same LangChain provider with the kernel directly (no graph):

```js
import { deepResearch, setLlmJsonProvider } from "@beevibe/architecture-deep-research";
import { createLangChainJsonProvider } from "@beevibe/architecture-deep-research/adapters/langgraph-llm";

setLlmJsonProvider(createLangChainJsonProvider({ model: "anthropic:claude-3-5-sonnet-latest" }), {
  label: "langchain:anthropic"
});
await deepResearch({ inputPath, flags: { domain, decision, out: outDir } });
```

### Back-compat

The previous single-node graph is still available as `createAdrLangGraphLegacy()` for callers that already install an LLM provider externally (for example via the Google ADK adapter) and only want LangGraph as a thin orchestration shell.

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

- the LangGraph runtime compiles a StateGraph with all five phase nodes (`prepare_run`, `plan_research`, `execute_research`, `synthesize_decision`, `write_artifacts`) and exposes the legacy single-node graph for back-compat;
- the LangChain JSON provider factory loads and returns a callable;
- the Google ADK tool-wrapper adapter can construct an agent with the ADR function tool;
- the Google ADK Gemini-as-provider adapter exports `createAdkJsonProvider`, `createAdkDeepResearchAgent`, and `createAdkDeepResearchTool`, and the kernel's `setLlmJsonProvider` / `getLlmJsonProvider` / `activeLlmProvider` hooks correctly install and report a custom provider label;
- the frozen kernel replay checks verify promotion normalization, hard-gated synthesis, citation-audit downgrade, and schema-valid artifact emission;
- framework packages load without coupling the kernel to one orchestrator.

## Dependency Notes

Current runtime integrations:

- `@langchain/langgraph`
- `langchain` (for the LangGraph runtime's `initChatModel`-based JSON provider)
- `@google/adk`

These are optional peer dependencies and dev dependencies in this repo. The ADR kernel remains callable without installing any framework in downstream deployments. Install the framework only when you use its adapter:

```bash
npm install @langchain/langgraph langchain @langchain/openai
# or @langchain/google-genai / @langchain/anthropic / @langchain/ollama / ...
npm install @google/adk
```

`npm audit --omit=dev` should stay clean for the framework-neutral ADR kernel.
