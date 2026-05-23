import {
  Command,
  createAdrLangGraph,
  createAdrLangGraphLegacy,
  resumeLangGraphDeepResearch,
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
  buildComparisonMatrix,
  buildKnowledgeMap,
  buildStrategicContext,
  deriveComparisonAxes,
  digestPaper,
  discoverPatterns,
  getLlmJsonProvider,
  inspectGithubRepo,
  isGithubRepoUrl,
  isPaperUrl,
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
  "compare_topologies",
  "synthesize_decision",
  "critique_decision",
  "verify_citations",
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
if (typeof resumeLangGraphDeepResearch !== "function") {
  throw new Error("LangGraph adapter did not export resumeLangGraphDeepResearch.");
}
if (typeof Command !== "function") {
  throw new Error("LangGraph adapter did not re-export Command for resume.");
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

// Structural smoke for code-aware, paper-aware, comparison-matrix exports.
if (typeof inspectGithubRepo !== "function" || typeof isGithubRepoUrl !== "function") {
  throw new Error("Kernel did not export GitHub inspection helpers.");
}
if (!isGithubRepoUrl("https://github.com/langchain-ai/langgraph")) {
  throw new Error("isGithubRepoUrl failed on a known github URL.");
}
if (isGithubRepoUrl("https://example.com/foo/bar")) {
  throw new Error("isGithubRepoUrl matched a non-github URL.");
}
if (isGithubRepoUrl("https://github.com/orgs/anthropic")) {
  throw new Error("isGithubRepoUrl matched a non-repo github route.");
}

if (typeof digestPaper !== "function" || typeof isPaperUrl !== "function") {
  throw new Error("Kernel did not export paper digest helpers.");
}
if (!isPaperUrl("https://arxiv.org/abs/2404.16130")) {
  throw new Error("isPaperUrl failed on an arXiv URL.");
}
if (!isPaperUrl("https://aclanthology.org/2024.acl-long.123")) {
  throw new Error("isPaperUrl failed on an ACL anthology URL.");
}
if (isPaperUrl("https://example.com/random-blog-post")) {
  throw new Error("isPaperUrl matched a non-paper URL.");
}

if (typeof buildComparisonMatrix !== "function") {
  throw new Error("Kernel did not export buildComparisonMatrix.");
}
// buildStrategicContext is LLM-derived; install a fixture provider for the
// hermetic smoke check so axes can be derived from a known-rich context.
setLlmJsonProvider(
  async ({ label }) => {
    if (label !== "strategic_context_extractor") {
      throw new Error(`smoke fixture: unexpected llm label ${label}`);
    }
    return {
      domain_entities: ["Contract", "Vendor", "Shipment"],
      bounded_contexts: ["IngestionContext", "KnowledgeGraphContext"],
      query_shapes: [
        { name: "multi_hop_relational", evidence: ["multi-hop entity relationships"] },
        { name: "audit_traceability", evidence: ["audit lineage"] }
      ],
      risk_invariants: [
        "Answers must resolve to source-backed evidence before being returned."
      ],
      operational_envelope: {
        latency: "p95 < 2s",
        cost: "not_specified",
        scale: "not_specified",
        availability: "not_specified"
      },
      compliance_constraints: ["audit traceability"]
    };
  },
  { label: "smoke-fixture" }
);
const sampleContext = await buildStrategicContext({
  sourcePath: "smoke",
  content:
    "Build a logistics contract knowledge system with audit lineage, multi-hop entity relationships, and deterministic retrieval routing.",
  domain: "logistics contract analysis",
  decision: "retrieval topology"
});
setLlmJsonProvider(null);
const axes = deriveComparisonAxes(sampleContext);
if (!Array.isArray(axes) || axes.length < 4) {
  throw new Error("deriveComparisonAxes returned too few axes for a rich context.");
}
// With empty knowledge map, comparison matrix should short-circuit without calling LLM.
const emptyMatrix = await buildComparisonMatrix({
  context: sampleContext,
  knowledgeMap: buildKnowledgeMap([]),
  evidenceItems: []
});
if (emptyMatrix.candidates.length !== 0 || emptyMatrix.cells.length !== 0) {
  throw new Error("buildComparisonMatrix should short-circuit on empty knowledge map.");
}

// Structural smoke for the discover stage export. We do not run a full discover
// pipeline here (that's covered hermetically by kernel-regression-tests.mjs) —
// we only verify the kernel exposes the entry point so adapters and CLIs can
// import it.
if (typeof discoverPatterns !== "function") {
  throw new Error("Kernel did not export discoverPatterns.");
}

console.log("framework smoke ok");
