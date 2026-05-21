import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runLangGraphDeepResearch } from "../adapters/langgraph.mjs";
import {
  createArchitectureDeepResearchAgent,
  createArchitectureDeepResearchTool
} from "../adapters/google-adk.mjs";

const tmp = await mkdtemp(path.join(os.tmpdir(), "adr-frameworks-"));
const inputPath = path.join(tmp, "product-context.md");
const langGraphOut = path.join(tmp, "langgraph-out");

await writeFile(
  inputPath,
  `# Product Context

Build a legal knowledge system with source-backed answers, audit lineage, multi-hop entity relationships, and deterministic retrieval routing.
`
);

const langGraphResult = await runLangGraphDeepResearch({
  inputPath,
  domain: "legal knowledge system",
  decision: "retrieval topology",
  outDir: langGraphOut,
  flags: {
    offline: true,
    "max-cycles": "1",
    "max-sources": "1"
  },
  threadId: "smoke-frameworks"
});

if (langGraphResult.handoffBoundary !== "adr_stops_at_execution_handoff") {
  throw new Error("LangGraph adapter did not return the ADR handoff boundary.");
}

JSON.parse(await readFile(path.join(langGraphOut, "execution-handoff.json"), "utf8"));

const adkAgent = createArchitectureDeepResearchAgent();
if (!adkAgent.name || !Array.isArray(adkAgent.tools) || adkAgent.tools.length === 0) {
  throw new Error("Google ADK adapter did not create an agent with tools.");
}

const adkTool = createArchitectureDeepResearchTool();
if (adkTool.name !== "run_architecture_deep_research") {
  throw new Error("Google ADK adapter did not create the expected tool.");
}

console.log("framework smoke ok");
