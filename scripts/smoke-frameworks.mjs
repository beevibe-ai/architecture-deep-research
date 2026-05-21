import {
  createAdrLangGraph,
  createAdrLangGraphLegacy,
  runLangGraphDeepResearch
} from "../adapters/langgraph.mjs";
import { createLangChainJsonProvider } from "../adapters/langgraph-llm.mjs";
import { createBeevibeArchitectAgentConfig } from "../adapters/beevibe.mjs";
import {
  createAdkDeepResearchAgent,
  createAdkDeepResearchTool,
  createAdkJsonProvider,
  createArchitectureDeepResearchAgent,
  createArchitectureDeepResearchTool
} from "../adapters/google-adk.mjs";
import {
  activeLlmProvider,
  getLlmJsonProvider,
  setLlmJsonProvider
} from "../src/kernel.mjs";

if (typeof runLangGraphDeepResearch !== "function") {
  throw new Error("LangGraph adapter did not export runLangGraphDeepResearch.");
}

// Structural check: the full StateGraph compiles and exposes all phase nodes.
const langGraph = createAdrLangGraph();
const expectedNodes = [
  "prepare_run",
  "plan_research",
  "execute_research",
  "synthesize_decision",
  "write_artifacts"
];
for (const node of expectedNodes) {
  if (!langGraph.nodes || !langGraph.nodes[node]) {
    throw new Error(`LangGraph runtime is missing the ${node} node.`);
  }
}
if (typeof createAdrLangGraphLegacy !== "function") {
  throw new Error("LangGraph adapter did not export createAdrLangGraphLegacy.");
}
if (typeof createLangChainJsonProvider !== "function") {
  throw new Error("LangGraph LLM adapter did not export createLangChainJsonProvider.");
}
const lcProvider = createLangChainJsonProvider({ model: "openai:gpt-4.1-mini" });
if (typeof lcProvider !== "function") {
  throw new Error("createLangChainJsonProvider did not return a function.");
}

const adkAgent = createArchitectureDeepResearchAgent();
if (!adkAgent.name || !Array.isArray(adkAgent.tools) || adkAgent.tools.length === 0) {
  throw new Error("Google ADK adapter did not create an agent with tools.");
}

const adkTool = createArchitectureDeepResearchTool();
if (adkTool.name !== "run_architecture_deep_research") {
  throw new Error("Google ADK adapter did not create the expected tool.");
}

const beevibeAgent = createBeevibeArchitectAgentConfig();
if (beevibeAgent.hierarchy_level !== "team" || beevibeAgent.review_policy !== "require_human") {
  throw new Error("Beevibe adapter did not create the expected Architect agent config.");
}

// Structural checks for the ADK-as-LLM-provider adapter (no API call).
const adkDeepAgent = createAdkDeepResearchAgent();
if (
  adkDeepAgent.name !== "architecture_deep_research_adk_root" ||
  !Array.isArray(adkDeepAgent.tools) ||
  adkDeepAgent.tools.length === 0
) {
  throw new Error("ADK deep research adapter did not create a root agent with tools.");
}

const adkDeepTool = createAdkDeepResearchTool();
if (adkDeepTool.name !== "run_adk_deep_research") {
  throw new Error("ADK deep research adapter did not create the expected tool.");
}

if (typeof createAdkJsonProvider !== "function") {
  throw new Error("createAdkJsonProvider was not exported.");
}
const adkProvider = createAdkJsonProvider({ model: "gemini-2.5-flash" });
if (typeof adkProvider !== "function") {
  throw new Error("createAdkJsonProvider did not return a function.");
}

// Verify the kernel's LLM provider hook is pluggable and reports the custom label.
const previousProvider = getLlmJsonProvider();
setLlmJsonProvider(adkProvider, { label: "adk-gemini:test" });
if (getLlmJsonProvider() !== adkProvider) {
  throw new Error("setLlmJsonProvider did not install the ADK provider.");
}
if (activeLlmProvider() !== "adk-gemini:test") {
  throw new Error("activeLlmProvider did not reflect the custom provider label.");
}
setLlmJsonProvider(previousProvider || null);
if (getLlmJsonProvider() !== previousProvider) {
  throw new Error("setLlmJsonProvider did not restore the previous provider.");
}

console.log("framework smoke ok");
