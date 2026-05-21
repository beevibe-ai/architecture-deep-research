import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function createBeevibeArchitectAgentConfig({
  name = "Architect",
  hierarchyLevel = "team",
  parentAgentId = null,
  reviewPolicy = "require_human",
  runtimeConfig = {}
} = {}) {
  return {
    name,
    hierarchy_level: hierarchyLevel,
    parent_agent_id: parentAgentId,
    runtime_config: {
      specialist: "architecture_deep_research",
      output_boundary: "adr_stops_at_execution_handoff",
      required_artifacts: [
        "architecture.spec.json",
        "domain-evaluation-pack.json",
        "execution-handoff.json",
        "agent-guardrails.md"
      ],
      ...runtimeConfig
    },
    review_policy: reviewPolicy
  };
}

function memoryFactsFromSpec(spec, knowledgeMap) {
  const candidates = [
    ...(knowledgeMap.promoted_candidates || []),
    ...(knowledgeMap.insufficient_evidence_candidates || [])
  ];

  return [
    {
      type: "architecture_decision",
      text: `ADR selected ${spec.decision.selected_topology} for ${spec.decision.title}.`,
      source: "architecture.spec.json",
      confidence: 0.9
    },
    ...candidates.slice(0, 8).map((candidate) => ({
      type: "architecture_precedent",
      text: `${candidate.label} was ${candidate.promotion_status} with citations ${candidate.citations.join(", ")}.`,
      source: "knowledge-map.json",
      confidence: candidate.promotion_status === "evidence_backed_candidate" ? 0.8 : 0.45
    }))
  ];
}

async function createBeevibeMeshHandoff({ outDir }) {
  const resolved = path.resolve(outDir);
  const spec = await readJson(path.join(resolved, "architecture.spec.json"));
  const handoff = await readJson(path.join(resolved, "execution-handoff.json"));
  const evaluationPack = await readJson(path.join(resolved, "domain-evaluation-pack.json"));
  const knowledgeMap = await readJson(path.join(resolved, "knowledge-map.json"));

  return {
    type: "architecture_deep_research_handoff",
    boundary: handoff.handoff_boundary,
    architect_agent: createBeevibeArchitectAgentConfig(),
    selected_topology: spec.decision.selected_topology,
    required_invariants: handoff.required_invariants,
    forbidden_topologies: handoff.forbidden_topologies,
    artifacts: Object.fromEntries(
      Object.entries(handoff.artifacts).map(([key, value]) => [key, path.join(resolved, value)])
    ),
    evaluation_suite: evaluationPack.suite,
    memory_facts: memoryFactsFromSpec(spec, knowledgeMap),
    mesh_instruction:
      "Route implementation work through the Architect specialist first. IC coding agents must consume this handoff before writing code and must request a superseding ADR before changing topology."
  };
}

async function writeBeevibeMeshHandoff({ outDir, targetPath }) {
  const handoff = await createBeevibeMeshHandoff({ outDir });
  const outputPath = path.resolve(targetPath || path.join(outDir, "beevibe-handoff.json"));
  await writeFile(outputPath, `${JSON.stringify(handoff, null, 2)}\n`);
  return handoff;
}

export {
  createBeevibeArchitectAgentConfig,
  createBeevibeMeshHandoff,
  writeBeevibeMeshHandoff
};
