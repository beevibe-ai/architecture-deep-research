#!/usr/bin/env node
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { activeSearchProviders, deepResearch } from "../src/kernel.mjs";

const DEFAULT_CONFIG = "benchmarks/configs/live.json";

function parseArgs(argv) {
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;

    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }

  return flags;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function recall(expected, actual) {
  if (!expected || expected.length === 0) return 1;
  const actualSet = new Set((actual || []).map(slugify));
  const hits = expected.filter((item) => actualSet.has(slugify(item))).length;
  return hits / expected.length;
}

function substringRecall(expectedSubstrings, actualValues) {
  if (!expectedSubstrings || expectedSubstrings.length === 0) return 1;
  const haystack = (actualValues || []).join("\n").toLowerCase();
  const hits = expectedSubstrings.filter((item) =>
    haystack.includes(String(item).toLowerCase())
  ).length;
  return hits / expectedSubstrings.length;
}

function weightedScore(metrics, weights) {
  return Object.entries(weights).reduce(
    (sum, [key, weight]) => sum + (metrics[key] || 0) * weight,
    0
  );
}

async function collectCases(caseDir) {
  const entries = await readdir(caseDir, { withFileTypes: true });
  const cases = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(caseDir, entry.name);
    const configPath = path.join(dir, "case.json");
    const config = await readJson(configPath);
    cases.push({
      ...config,
      dir,
      inputPath: path.join(dir, config.input)
    });
  }

  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

function scoreCase({ caseConfig, spec, evaluationPack, handoff, clarification }) {
  const expected = caseConfig.expected;
  const actualForbidden = spec.guardrails?.forbidden_topologies || [];
  const actualInvariants = spec.guardrails?.required_invariants || [];
  const actualTestTypes = unique(
    (evaluationPack.test_cases || []).map((testCase) => testCase.type)
  );

  const metrics = {
    selected_topology:
      slugify(spec.decision?.selected_topology) === slugify(expected.selected_topology)
        ? 1
        : 0,
    forbidden_topologies: recall(expected.forbidden_topologies, actualForbidden),
    required_invariants: substringRecall(
      expected.required_invariant_substrings,
      actualInvariants
    ),
    evaluation_tests: recall(expected.evaluation_test_types, actualTestTypes),
    handoff_boundary:
      handoff.handoff_boundary === "adr_stops_at_execution_handoff" ? 1 : 0,
    clarification:
      clarification.needs_clarification === expected.needs_clarification ? 1 : 0
  };

  return metrics;
}

async function runCase({ caseConfig, config, runRoot }) {
  const caseOutDir = path.join(runRoot, "cases", caseConfig.id);
  const flags = {
    ...config.runner_flags,
    domain: caseConfig.domain,
    decision: caseConfig.decision,
    out: caseOutDir
  };

  await deepResearch({
    inputPath: caseConfig.inputPath,
    flags
  });

  const spec = await readJson(path.join(caseOutDir, "architecture.spec.json"));
  const evaluationPack = await readJson(
    path.join(caseOutDir, "domain-evaluation-pack.json")
  );
  const handoff = await readJson(path.join(caseOutDir, "execution-handoff.json"));
  const clarification = await readJson(path.join(caseOutDir, "clarification.json"));

  const metrics = scoreCase({
    caseConfig,
    spec,
    evaluationPack,
    handoff,
    clarification
  });
  const score = weightedScore(metrics, config.weights);
  const passed = score >= config.passing_score;

  return {
    id: caseConfig.id,
    domain: caseConfig.domain,
    decision: caseConfig.decision,
    expected_topology: caseConfig.expected.selected_topology,
    actual_topology: spec.decision?.selected_topology,
    score,
    passed,
    metrics,
    output_dir: caseOutDir
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(flags.config || DEFAULT_CONFIG);
  const strict = Boolean(flags.strict);
  const config = await readJson(configPath);
  const searchProviders = activeSearchProviders();
  if (searchProviders.length === 0) {
    throw new Error(
      "Live benchmark requires BRAVE_SEARCH_API_KEY, SERPER_API_KEY, TAVILY_API_KEY, or SEARXNG_URL."
    );
  }
  if (!process.env.ADR_OPENAI_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ADR_OPENAI_BASE_URL && !process.env.OPENAI_BASE_URL) {
    throw new Error(
      "Live benchmark requires ADR_OPENAI_API_KEY or OPENAI_API_KEY, or an OpenAI-compatible ADR_OPENAI_BASE_URL."
    );
  }
  const caseDir = path.resolve(config.case_dir);
  const runRoot = path.resolve(config.output_dir, "latest");

  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });

  const cases = await collectCases(caseDir);
  const startedAt = new Date().toISOString();
  const results = [];

  for (const caseConfig of cases) {
    console.log(`benchmark: ${caseConfig.id}`);
    results.push(await runCase({ caseConfig, config, runRoot }));
  }

  const averageScore =
    results.reduce((sum, result) => sum + result.score, 0) / Math.max(results.length, 1);
  const passed = results.every((result) => result.passed);
  const summary = {
    version: "0.1.0",
    config: config.name,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    case_count: results.length,
    average_score: averageScore,
    passing_score: config.passing_score,
    passed,
    results
  };

  await writeFile(path.join(runRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(path.join(runRoot, "summary.md"), renderSummary(summary));

  console.log(`average score: ${averageScore.toFixed(3)}`);
  console.log(`summary: ${path.join(runRoot, "summary.json")}`);

  if (strict && !passed) {
    process.exitCode = 1;
  }
}

function renderSummary(summary) {
  const rows = summary.results
    .map(
      (result) =>
        `| ${result.id} | ${result.expected_topology} | ${result.actual_topology} | ${result.score.toFixed(3)} | ${result.passed ? "pass" : "fail"} |`
    )
    .join("\n");

  return `# ADR Benchmark Summary

- Config: ${summary.config}
- Cases: ${summary.case_count}
- Average score: ${summary.average_score.toFixed(3)}
- Passing score: ${summary.passing_score}
- Status: ${summary.passed ? "pass" : "fail"}

| Case | Expected | Actual | Score | Status |
| --- | --- | --- | --- | --- |
${rows}
`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
