import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph
} from "@langchain/langgraph";
import { deepResearch } from "../scripts/adr.mjs";

const AdrLangGraphState = Annotation.Root({
  inputPath: Annotation(),
  domain: Annotation(),
  decision: Annotation(),
  outDir: Annotation(),
  flags: Annotation(),
  status: Annotation(),
  selectedTopology: Annotation(),
  evidenceCount: Annotation(),
  handoffBoundary: Annotation(),
  artifacts: Annotation()
});

function buildFlags(state) {
  return {
    ...(state.flags || {}),
    domain: state.domain,
    decision: state.decision,
    out: state.outDir
  };
}

async function runAdrKernelNode(state) {
  await deepResearch({
    inputPath: state.inputPath,
    flags: buildFlags(state)
  });

  return {
    status: "kernel_completed"
  };
}

async function loadRunStateNode(state) {
  const statePath = path.join(path.resolve(state.outDir), "state.json");
  const handoffPath = path.join(path.resolve(state.outDir), "execution-handoff.json");
  const runState = JSON.parse(await readFile(statePath, "utf8"));
  const handoff = JSON.parse(await readFile(handoffPath, "utf8"));

  return {
    status: runState.status,
    selectedTopology: runState.selected_topology,
    evidenceCount: runState.evidence_count,
    handoffBoundary: runState.handoff_boundary,
    artifacts: handoff.artifacts
  };
}

export function createAdrLangGraph() {
  return new StateGraph(AdrLangGraphState)
    .addNode("run_adr_deep_research_kernel", runAdrKernelNode)
    .addNode("load_execution_handoff", loadRunStateNode)
    .addEdge(START, "run_adr_deep_research_kernel")
    .addEdge("run_adr_deep_research_kernel", "load_execution_handoff")
    .addEdge("load_execution_handoff", END)
    .compile({
      checkpointer: new MemorySaver()
    });
}

export async function runLangGraphDeepResearch({
  inputPath,
  domain,
  decision,
  outDir,
  flags = {},
  threadId = `adr-${Date.now()}`
}) {
  const graph = createAdrLangGraph();
  return graph.invoke(
    {
      inputPath,
      domain,
      decision,
      outDir,
      flags
    },
    {
      configurable: {
        thread_id: threadId
      }
    }
  );
}
