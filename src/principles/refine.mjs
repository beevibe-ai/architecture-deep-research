// Refine a single principle — re-run discovery scoped to one principle's
// lens + cited files. Targeted at the case where `adr review` stats show
// a principle is wrong (high skip rate) or the message is wrong (high
// edit rate). Faster than a full refresh; replaces only the named
// principle.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  activeLlmProvider,
  appendEvent,
  nowIso,
  resetLlmCost,
  VERSION,
  writeJson
} from "../kernel.mjs";
import { scanRepo } from "../discover/repo-scan.mjs";
import { sampleRepoSource } from "./source-sampler.mjs";
import { extractPatternsForLens } from "./pattern-extractor.mjs";
import {
  generateInterviewQuestions,
  runInteractiveInterview
} from "./interview.mjs";
import { consolidatePrinciples } from "./consolidator.mjs";
import { pruneFabricatedCitations } from "./cite-verifier.mjs";
import { renderPrinciplesMarkdown } from "./render-markdown.mjs";

function assertRuntime() {
  if (!activeLlmProvider()) {
    throw new Error(
      "No LLM provider configured. Set ADR_OPENAI_API_KEY or OPENAI_API_KEY before `adr principles refine`."
    );
  }
}

async function refinePrinciple({ inputPath, flags = {} } = {}) {
  const targetId = inputPath;
  if (!targetId) {
    throw new Error(
      "adr principles refine requires a principle id. Example: `adr principles refine schema-validate-before-write`."
    );
  }
  assertRuntime();
  const repoPath = path.resolve(flags.repo || ".");
  const outDir = path.resolve(flags.out || path.join(repoPath, ".adr"));
  const interactive = flags["non-interactive"] !== true;

  const principlesPath = path.join(outDir, "principles.json");
  let priorArtifact;
  try {
    priorArtifact = JSON.parse(await readFile(principlesPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `principles.json not found in ${outDir}. Run \`adr principles init\` first.`
      );
    }
    throw error;
  }

  const target = priorArtifact.principles.find((p) => p.id === targetId);
  if (!target) {
    throw new Error(
      `Principle "${targetId}" not found. Available: ${priorArtifact.principles
        .map((p) => p.id)
        .join(", ")}`
    );
  }
  const targetLens = priorArtifact.lenses.find((l) => l.slug === target.lens);
  if (!targetLens) {
    throw new Error(
      `Lens "${target.lens}" referenced by principle "${targetId}" not found in prior lenses.`
    );
  }

  await writeFile(path.join(outDir, "events.jsonl"), "");
  resetLlmCost();
  const startedAt = nowIso();

  await appendEvent(outDir, "refine_started", {
    principle_id: targetId,
    lens_slug: target.lens,
    repo_path: repoPath
  });

  // Scan + sample (broad — gives the LLM enough context for the lens).
  const scan = await scanRepo(repoPath);
  const sourceSample = await sampleRepoSource(repoPath);
  await appendEvent(outDir, "source_sampled", {
    sample_count: sourceSample.summary.total_files,
    mode: "refine"
  });

  // Re-extract for ONE lens only.
  const extraction = await extractPatternsForLens(
    scan,
    sourceSample,
    targetLens
  );
  await appendEvent(outDir, "lens_patterns_extracted", {
    lens_slug: extraction.lens_slug,
    positive_count: extraction.positive_patterns.length,
    antipattern_count: extraction.antipatterns.length,
    ambiguity_count: extraction.ambiguities.length,
    refining_id: targetId
  });

  let interviewLog = [];
  if (interactive) {
    const questions = await generateInterviewQuestions([extraction], {
      priorInterviewLog: priorArtifact.interview_log || []
    });
    await appendEvent(outDir, "interview_generated", {
      question_count: questions.length,
      mode: "refine"
    });
    if (questions.length === 0) {
      console.log(
        "\nNo new ambiguities for this lens. Re-consolidating with prior interview answers."
      );
    } else {
      interviewLog = await runInteractiveInterview(questions);
    }
  }

  const rawPrinciples = await consolidatePrinciples({
    lenses: [targetLens],
    perLensExtractions: [extraction],
    interviewLog: [
      ...(priorArtifact.interview_log || []),
      ...interviewLog
    ]
  });
  await appendEvent(outDir, "principles_consolidated", {
    principle_count: rawPrinciples.length,
    mode: "refine"
  });

  const { principles: prunedNew, summary: citeSummary } =
    await pruneFabricatedCitations(rawPrinciples, repoPath);
  await appendEvent(outDir, "citations_verified", citeSummary);

  // Find the best replacement for the target. Prefer a principle with the
  // same ID; otherwise the one with the most evidence_cite overlap.
  const replacement = pickBestReplacement(prunedNew, target);
  if (!replacement) {
    console.log(
      `\nRefine produced no usable replacement for "${targetId}". Keeping the prior version. (Try \`adr principles refresh\` if the lens itself has shifted.)`
    );
    await appendEvent(outDir, "refine_no_replacement", { principle_id: targetId });
    return {
      outDir,
      replaced: false,
      target,
      principles: priorArtifact.principles
    };
  }

  // Build the new principles list: replace target, leave the rest alone.
  const refinedPrinciples = priorArtifact.principles.map((p) =>
    p.id === targetId ? { ...replacement, id: targetId } : p
  );

  // Add any extra new principles discovered for the same lens that don't
  // overlap with existing ones — they're real new findings.
  for (const np of prunedNew) {
    if (np === replacement) continue;
    const overlapsExisting = priorArtifact.principles.some(
      (p) =>
        p.lens === np.lens &&
        (p.id === np.id ||
          (p.evidence_cite || []).some((c) =>
            (np.evidence_cite || []).includes(c)
          ))
    );
    if (!overlapsExisting) {
      refinedPrinciples.push(np);
    }
  }

  const artifact = {
    ...priorArtifact,
    source: {
      ...priorArtifact.source,
      scanned_at: startedAt,
      mode: "refine",
      refined_id: targetId
    },
    principles: refinedPrinciples,
    interview_log: [
      ...(priorArtifact.interview_log || []),
      ...interviewLog
    ]
  };

  const mdPath = path.join(outDir, "principles.md");
  await writeJson(principlesPath, artifact);
  const markdown = renderPrinciplesMarkdown(artifact);
  await writeFile(mdPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`);

  await appendEvent(outDir, "refine_completed", {
    principle_id: targetId,
    replaced: true,
    new_rule: replacement.rule,
    added_alongside: refinedPrinciples.length - priorArtifact.principles.length
  });

  return {
    outDir,
    replaced: true,
    target,
    replacement,
    principles: refinedPrinciples,
    jsonPath: principlesPath,
    mdPath
  };
}

function pickBestReplacement(candidates, target) {
  if (candidates.length === 0) return null;
  // Prefer exact ID match (LLM may be stable).
  const idMatch = candidates.find((c) => c.id === target.id);
  if (idMatch) return idMatch;

  // Otherwise pick the candidate with the most evidence_cite filename
  // overlap with the target.
  const targetFiles = new Set(
    (target.evidence_cite || [])
      .map((c) => c.split(":")[0])
      .filter(Boolean)
  );
  let best = null;
  let bestOverlap = 0;
  for (const c of candidates) {
    const candidateFiles = (c.evidence_cite || [])
      .map((cite) => cite.split(":")[0])
      .filter(Boolean);
    const shared = candidateFiles.filter((f) => targetFiles.has(f)).length;
    if (shared > bestOverlap) {
      bestOverlap = shared;
      best = c;
    }
  }
  return best;
}

export { refinePrinciple, pickBestReplacement };
