import { runLangGraphDeepResearch } from "../adapters/langgraph.mjs";
import { createBeevibeArchitectAgentConfig } from "../adapters/beevibe.mjs";
import {
  createArchitectureDeepResearchAgent,
  createArchitectureDeepResearchTool
} from "../adapters/google-adk.mjs";

if (typeof runLangGraphDeepResearch !== "function") {
  throw new Error("LangGraph adapter did not export runLangGraphDeepResearch.");
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

console.log("framework smoke ok");
