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
      output_boundary: "adr_stops_at_research_report",
      required_artifacts: [
        "research-report.json",
        "ADR.md"
      ],
      handoff_artifacts: [
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
    ...(knowledgeMap.candidates || []),
    ...(knowledgeMap.off_topic_candidates || [])
  ];

  return [
    {
      type: "architecture_decision",
      text: `ADR mapped ${(spec.options || []).length} candidates for ${spec.title || spec.id || "the decision"}.`,
      source: "research-report.json",
      confidence: 0.9
    },
    ...candidates.slice(0, 8).map((candidate) => ({
      type: "architecture_precedent",
      text: `${candidate.label} surfaced with evidence_depth=${candidate.evidence_depth || "thin"} (citations ${(candidate.citations || []).join(", ")}).`,
      source: "knowledge-map.json",
      confidence: candidate.evidence_depth === "thick" ? 0.8 : candidate.evidence_depth === "medium" ? 0.65 : 0.45
    }))
  ];
}

async function createBeevibeMeshHandoff({ outDir }) {
  const resolved = path.resolve(outDir);
  const spec = await readJson(path.join(resolved, "research-report.json"));
  const knowledgeMap = await readJson(path.join(resolved, "knowledge-map.json"));
  // execution-handoff.json is optional — produced only when `adr handoff`
  // ran for a chosen candidate.
  let handoff = null;
  try {
    handoff = await readJson(path.join(resolved, "execution-handoff.json"));
  } catch {
    // missing — caller hasn't run `adr handoff` yet
  }
  let evaluationPack = null;
  try {
    evaluationPack = await readJson(path.join(resolved, "domain-evaluation-pack.json"));
  } catch {
    // missing — same reason
  }

  return {
    type: "architecture_deep_research_handoff",
    boundary: handoff?.handoff_boundary || "adr_stops_at_research_report",
    architect_agent: createBeevibeArchitectAgentConfig(),
    chosen_option: handoff?.chosen_option || null,
    artifacts: handoff
      ? Object.fromEntries(
          Object.entries(handoff.artifacts || {}).map(([key, value]) => [key, path.join(resolved, value)])
        )
      : {
          adr: path.join(resolved, "ADR.md"),
          research_report: path.join(resolved, "research-report.json")
        },
    evaluation_suite: evaluationPack?.suite || null,
    memory_facts: memoryFactsFromSpec(spec, knowledgeMap),
    mesh_instruction:
      handoff?.chosen_option
        ? `Route implementation work through the Architect specialist using the ${handoff.chosen_option} contract. IC coding agents must consume this handoff before writing code and must request a superseding ADR before changing topology.`
        : "ADR produced a research report. Pick a candidate, then run `adr handoff <out_dir> --option <name>` to generate an implementation contract before routing work."
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
