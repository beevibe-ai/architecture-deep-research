import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
  interrupt
} from "@langchain/langgraph";
import {
  applyCritique,
  compareTopologiesPhase,
  critiqueDecisionPhase,
  deepResearch,
  executeResearchPhase,
  getLlmJsonProvider,
  planResearchPhase,
  prepareRun,
  setLlmJsonProvider,
  synthesizeDecisionPhase,
  verifyCitationsPhase,
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
  comparisonMatrix: Annotation(),
  adversarialCycles: Annotation(),
  critique: Annotation(),
  citationAudit: Annotation(),
  decisionDowngraded: Annotation(),

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
  const flags = buildFlags(state);
  const plan = await planResearchPhase({
    context: state.context,
    content: state.content,
    outDir: state.resolvedOutDir,
    flags
  });

  if (!flags["plan-approval"]) {
    return { plan, status: "plan_ready" };
  }

  // Human-in-the-loop: pause and let the operator approve or edit the plan.
  // `interrupt` throws GraphInterrupt; the value below is surfaced as
  // `task.interrupts[].value` for the caller. Resume with
  //   graph.invoke(new Command({ resume: { action: "approve" } }))
  // or graph.invoke(new Command({ resume: { action: "edit", plan: newPlan } }))
  const response = interrupt({
    type: "plan_approval",
    plan,
    instructions: [
      "Resume with Command({ resume: { action: 'approve' } }) to accept the plan as-is.",
      "Resume with Command({ resume: { action: 'edit', plan: <plan object> } }) to replace the plan.",
      "Resume with Command({ resume: { action: 'abort' } }) to terminate the run."
    ]
  });

  if (response?.action === "abort") {
    return {
      status: "aborted_by_human",
      handoffBoundary: "adr_aborted_during_plan_approval"
    };
  }
  if (response?.action === "edit" && response.plan) {
    return { plan: response.plan, status: "plan_edited_by_human" };
  }
  return { plan, status: "plan_approved_by_human" };
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

async function compareTopologiesNode(state) {
  const flags = buildFlags(state);
  if (flags["skip-comparison-matrix"]) {
    return { comparisonMatrix: null, status: "comparison_matrix_skipped" };
  }
  const {
    comparisonMatrix,
    researchResults,
    evidenceItems,
    knowledgeMap,
    adversarialCycles
  } = await compareTopologiesPhase({
    context: state.context,
    knowledgeMap: state.knowledgeMap,
    evidenceItems: state.evidenceItems,
    researchResults: state.researchResults,
    outDir: state.resolvedOutDir,
    flags
  });
  return {
    comparisonMatrix,
    researchResults,
    evidenceItems,
    knowledgeMap,
    adversarialCycles,
    status: "comparison_matrix_ready"
  };
}

async function synthesizeDecisionNode(state) {
  const spec = await synthesizeDecisionPhase({
    context: state.context,
    knowledgeMap: state.knowledgeMap,
    evidenceItems: state.evidenceItems,
    comparisonMatrix: state.comparisonMatrix
  });
  return { spec, status: "decision_synthesized" };
}

async function critiqueDecisionNode(state) {
  const flags = buildFlags(state);
  if (flags["skip-critique"]) {
    return { critique: null, status: "critique_skipped" };
  }
  const critique = await critiqueDecisionPhase({
    context: state.context,
    spec: state.spec,
    knowledgeMap: state.knowledgeMap,
    evidenceItems: state.evidenceItems,
    outDir: state.resolvedOutDir
  });
  const { spec: finalSpec, downgraded } = applyCritique({
    spec: state.spec,
    critique,
    flags
  });
  return {
    critique,
    spec: finalSpec,
    decisionDowngraded: downgraded,
    status: downgraded ? "decision_downgraded_by_critique" : "critique_completed"
  };
}

async function verifyCitationsNode(state) {
  const flags = buildFlags(state);
  if (flags["skip-citation-audit"]) {
    return { citationAudit: null, status: "citation_audit_skipped" };
  }
  const citationAudit = await verifyCitationsPhase({
    context: state.context,
    spec: state.spec,
    evidenceItems: state.evidenceItems,
    outDir: state.resolvedOutDir
  });
  return { citationAudit, status: "citation_audit_completed" };
}

async function writeArtifactsNode(state) {
  const result = await writeRunArtifacts({
    context: state.context,
    plan: state.plan,
    spec: state.spec,
    evidenceItems: state.evidenceItems,
    researchResults: state.researchResults,
    knowledgeMap: state.knowledgeMap,
    outDir: state.resolvedOutDir,
    critique: state.critique || null,
    citationAudit: state.citationAudit || null,
    comparisonMatrix: state.comparisonMatrix || null,
    flags: buildFlags(state)
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

function routeAfterPlan(state) {
  return state.status === "aborted_by_human" ? END : "execute_research";
}

export function createAdrLangGraph({ checkpointer } = {}) {
  return new StateGraph(AdrLangGraphState)
    .addNode("prepare_run", prepareRunNode)
    .addNode("plan_research", planResearchNode)
    .addNode("execute_research", executeResearchNode)
    .addNode("compare_topologies", compareTopologiesNode)
    .addNode("synthesize_decision", synthesizeDecisionNode)
    .addNode("critique_decision", critiqueDecisionNode)
    .addNode("verify_citations", verifyCitationsNode)
    .addNode("write_artifacts", writeArtifactsNode)
    .addEdge(START, "prepare_run")
    .addConditionalEdges("prepare_run", routeAfterPrepare, {
      plan_research: "plan_research",
      [END]: END
    })
    .addConditionalEdges("plan_research", routeAfterPlan, {
      execute_research: "execute_research",
      [END]: END
    })
    .addEdge("execute_research", "compare_topologies")
    .addEdge("compare_topologies", "synthesize_decision")
    .addEdge("synthesize_decision", "critique_decision")
    .addEdge("critique_decision", "verify_citations")
    .addEdge("verify_citations", "write_artifacts")
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
  checkpointer,
  graph
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
    const compiledGraph = graph || createAdrLangGraph({ checkpointer });
    return await compiledGraph.invoke(
      { inputPath, domain, decision, outDir, flags, model },
      { configurable: { thread_id: threadId } }
    );
  } finally {
    setLlmJsonProvider(previousProvider || null, {
      label: previousProvider ? "restored" : "none"
    });
  }
}

/**
 * Resume a paused LangGraph deep-research run. The caller must reuse the
 * same compiled graph (or supply the same checkpointer) and the same
 * threadId that was used in the original `runLangGraphDeepResearch` call.
 *
 * @param {object} params
 * @param {object} params.graph compiled graph from createAdrLangGraph
 * @param {string} params.threadId the thread_id used for the original run
 * @param {{ action: 'approve' | 'edit' | 'abort', plan?: object }} params.resume
 * @param {string} [params.model] keep the same model as the original run
 */
export async function resumeLangGraphDeepResearch({
  graph,
  threadId,
  resume,
  model = DEFAULT_MODEL_STRING
}) {
  if (!graph) throw new Error("resumeLangGraphDeepResearch requires graph.");
  if (!threadId) throw new Error("resumeLangGraphDeepResearch requires threadId.");
  if (!resume) throw new Error("resumeLangGraphDeepResearch requires a resume payload.");

  const previousProvider = getLlmJsonProvider();
  setLlmJsonProvider(createLangChainJsonProvider({ model }), {
    label: `langchain:${model}`
  });

  try {
    return await graph.invoke(new Command({ resume }), {
      configurable: { thread_id: threadId }
    });
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

export { Command, DEFAULT_MODEL_STRING };
