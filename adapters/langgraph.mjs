import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph
} from "@langchain/langgraph";
import {
  deepResearch,
  executeResearchPhase,
  getLlmJsonProvider,
  planResearchPhase,
  prepareRun,
  setLlmJsonProvider,
  synthesizeDecisionPhase,
  writeRunArtifacts
} from "../src/kernel.mjs";
import {
  DEFAULT_MODEL_STRING,
  createLangChainJsonProvider
} from "./langgraph-llm.mjs";

const AdrLangGraphState = Annotation.Root({
  inputPath: Annotation(),
  domain: Annotation(),
  decision: Annotation(),
  outDir: Annotation(),
  flags: Annotation(),
  model: Annotation(),

  // Phase outputs propagated through the graph.
  runtime: Annotation(),
  resolvedOutDir: Annotation(),
  content: Annotation(),
  context: Annotation(),
  clarification: Annotation(),
  needsClarification: Annotation(),
  plan: Annotation(),
  evidenceItems: Annotation(),
  knowledgeMap: Annotation(),
  researchResults: Annotation(),
  spec: Annotation(),

  // Terminal status.
  status: Annotation(),
  selectedTopology: Annotation(),
  evidenceCount: Annotation(),
  promotedCandidateCount: Annotation(),
  handoffBoundary: Annotation()
});

function buildFlags(state) {
  return {
    ...(state.flags || {}),
    domain: state.domain,
    decision: state.decision,
    out: state.outDir
  };
}

async function prepareRunNode(state) {
  const prepared = await prepareRun({
    inputPath: state.inputPath,
    flags: buildFlags(state)
  });
  if (prepared.needsClarification) {
    return {
      runtime: prepared.runtime,
      resolvedOutDir: prepared.outDir,
      content: prepared.content,
      context: prepared.context,
      clarification: prepared.clarification,
      needsClarification: true,
      status: "needs_clarification",
      handoffBoundary: "adr_not_started_due_to_missing_context"
    };
  }
  return {
    runtime: prepared.runtime,
    resolvedOutDir: prepared.outDir,
    content: prepared.content,
    context: prepared.context,
    clarification: prepared.clarification,
    needsClarification: false,
    status: "context_ready"
  };
}

async function planResearchNode(state) {
  const plan = await planResearchPhase({
    context: state.context,
    content: state.content,
    outDir: state.resolvedOutDir,
    flags: buildFlags(state)
  });
  return { plan, status: "plan_ready" };
}

async function executeResearchNode(state) {
  const { researchResults, evidenceItems, knowledgeMap } =
    await executeResearchPhase({
      plan: state.plan,
      context: state.context,
      outDir: state.resolvedOutDir,
      flags: buildFlags(state)
    });
  return {
    researchResults,
    evidenceItems,
    knowledgeMap,
    status: "evidence_collected"
  };
}

async function synthesizeDecisionNode(state) {
  const spec = await synthesizeDecisionPhase({
    context: state.context,
    knowledgeMap: state.knowledgeMap,
    evidenceItems: state.evidenceItems
  });
  return { spec, status: "decision_synthesized" };
}

async function writeArtifactsNode(state) {
  const result = await writeRunArtifacts({
    context: state.context,
    plan: state.plan,
    spec: state.spec,
    evidenceItems: state.evidenceItems,
    researchResults: state.researchResults,
    knowledgeMap: state.knowledgeMap,
    outDir: state.resolvedOutDir
  });
  return {
    status: "completed",
    selectedTopology: result.selectedTopology,
    evidenceCount: result.evidenceCount,
    promotedCandidateCount: result.promotedCandidateCount,
    handoffBoundary: result.handoffBoundary
  };
}

function routeAfterPrepare(state) {
  return state.needsClarification ? END : "plan_research";
}

export function createAdrLangGraph({ checkpointer } = {}) {
  return new StateGraph(AdrLangGraphState)
    .addNode("prepare_run", prepareRunNode)
    .addNode("plan_research", planResearchNode)
    .addNode("execute_research", executeResearchNode)
    .addNode("synthesize_decision", synthesizeDecisionNode)
    .addNode("write_artifacts", writeArtifactsNode)
    .addEdge(START, "prepare_run")
    .addConditionalEdges("prepare_run", routeAfterPrepare, {
      plan_research: "plan_research",
      [END]: END
    })
    .addEdge("plan_research", "execute_research")
    .addEdge("execute_research", "synthesize_decision")
    .addEdge("synthesize_decision", "write_artifacts")
    .addEdge("write_artifacts", END)
    .compile({
      checkpointer: checkpointer || new MemorySaver()
    });
}

export async function runLangGraphDeepResearch({
  inputPath,
  domain,
  decision,
  outDir,
  flags = {},
  model = DEFAULT_MODEL_STRING,
  threadId = `adr-${Date.now()}`,
  checkpointer
}) {
  if (!inputPath || !domain || !decision || !outDir) {
    throw new Error(
      "runLangGraphDeepResearch requires inputPath, domain, decision, outDir."
    );
  }

  const previousProvider = getLlmJsonProvider();
  setLlmJsonProvider(createLangChainJsonProvider({ model }), {
    label: `langchain:${model}`
  });

  try {
    const graph = createAdrLangGraph({ checkpointer });
    return await graph.invoke(
      { inputPath, domain, decision, outDir, flags, model },
      { configurable: { thread_id: threadId } }
    );
  } finally {
    setLlmJsonProvider(previousProvider || null, {
      label: previousProvider ? "restored" : "none"
    });
  }
}

// Back-compat: a single-node graph that calls the kernel end-to-end.
// Useful when an external caller has already installed an LLM provider
// (for example via the ADK adapter) and only wants LangGraph as a thin
// orchestration shell.
async function runFullKernelNode(state) {
  await deepResearch({
    inputPath: state.inputPath,
    flags: buildFlags(state)
  });
  return { status: "completed", handoffBoundary: "adr_stops_at_execution_handoff" };
}

export function createAdrLangGraphLegacy() {
  return new StateGraph(AdrLangGraphState)
    .addNode("run_adr_deep_research_kernel", runFullKernelNode)
    .addEdge(START, "run_adr_deep_research_kernel")
    .addEdge("run_adr_deep_research_kernel", END)
    .compile({ checkpointer: new MemorySaver() });
}

export { DEFAULT_MODEL_STRING };
