import { Agent, FunctionTool } from "@google/adk";
import { deepResearch } from "../src/kernel.mjs";
import {
  createAdkDeepResearchAgent,
  createAdkDeepResearchTool,
  createAdkJsonProvider,
  runAdkDeepResearch
} from "./google-adk-deep-research.mjs";

export {
  createAdkDeepResearchAgent,
  createAdkDeepResearchTool,
  createAdkJsonProvider,
  runAdkDeepResearch
};

export async function runArchitectureDeepResearchTool(input) {
  const {
    inputPath,
    domain,
    decision,
    outDir,
    flags = {}
  } = input;

  await deepResearch({
    inputPath,
    flags: {
      ...flags,
      domain,
      decision,
      out: outDir
    }
  });

  return {
    status: "completed",
    outDir,
    boundary: "adr_stops_at_execution_handoff"
  };
}

export function createArchitectureDeepResearchTool() {
  return new FunctionTool({
    name: "run_architecture_deep_research",
    description:
      "Run Architecture Deep Research over a local product brief and emit ADR artifacts ending at Execution Handoff.",
    parameters: {
      type: "object",
      properties: {
        inputPath: {
          type: "string",
          description: "Path to the product context or PRD file."
        },
        domain: {
          type: "string",
          description: "Business or product domain being analyzed."
        },
        decision: {
          type: "string",
          description: "Architecture decision focus, such as retrieval topology."
        },
        outDir: {
          type: "string",
          description: "Directory where ADR artifacts should be written."
        },
        flags: {
          type: "object",
          description:
            "Optional ADR runtime flags such as max-cycles, max-sources, or fetch-timeout-ms. ADR runs always require live search and LLM synthesis."
        }
      },
      required: ["inputPath", "domain", "decision", "outDir"]
    },
    execute: runArchitectureDeepResearchTool
  });
}

export function createArchitectureDeepResearchAgent({
  model = process.env.ADR_ADK_MODEL || "gemini-2.5-flash"
} = {}) {
  return new Agent({
    name: "architecture_deep_research_architect",
    model,
    description:
      "A Beevibe Architecture Deep Research specialist that chooses architecture families and emits execution handoff artifacts.",
    instruction:
      "You are the Architecture Deep Research Architect. Use the run_architecture_deep_research tool to research system design decisions. Stop at Execution Handoff; never implement the downstream product.",
    tools: [createArchitectureDeepResearchTool()]
  });
}

export const rootAgent = createArchitectureDeepResearchAgent();
