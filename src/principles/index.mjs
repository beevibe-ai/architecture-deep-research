import { mkdir, writeFile } from "node:fs/promises";
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
import { discoverLenses } from "./lens-discovery.mjs";
import { extractPatternsForLens } from "./pattern-extractor.mjs";
import {
  generateInterviewQuestions,
  runInteractiveInterview
} from "./interview.mjs";
import { consolidatePrinciples } from "./consolidator.mjs";
import { pruneFabricatedCitations } from "./cite-verifier.mjs";
import { renderPrinciplesMarkdown } from "./render-markdown.mjs";

function assertPrinciplesRuntime() {
  const llm = activeLlmProvider();
  if (!llm) {
    throw new Error(
      "No LLM provider configured. Set ADR_OPENAI_API_KEY or OPENAI_API_KEY before running `adr principles init`."
    );
  }
  return { llmProvider: llm };
}

async function discoverPrinciples({ flags = {} } = {}) {
  const repoPath = path.resolve(flags.repo || ".");
  const outDir = path.resolve(flags.out || path.join(repoPath, ".adr"));
  const interactive = flags["non-interactive"] !== true;

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "events.jsonl"), "");
  resetLlmCost();

  const runtime = assertPrinciplesRuntime();
  const startedAt = nowIso();

  await appendEvent(outDir, "principles_started", {
    runtime,
    repo_path: repoPath,
    out_dir: outDir,
    interactive
  });

  // STEP 1 — deterministic scan (no LLM, reused from discover/)
  const scan = await scanRepo(repoPath);
  await appendEvent(outDir, "repo_scanned", { ...scan.summary });

  // STEP 1b — sample real source code so lens discovery and extraction can
  // cite actual lines, not invented ones. discover/repo-scan deliberately
  // skips source content; we add it back here because principle extraction
  // is the use case that needs it.
  const sourceSample = await sampleRepoSource(repoPath);
  await appendEvent(outDir, "source_sampled", {
    sample_count: sourceSample.summary.total_files,
    top_levels: sourceSample.summary.top_levels
  });

  // STEP 2 — discover lenses for this team
  const lenses = await discoverLenses(scan, sourceSample);
  await appendEvent(outDir, "lenses_discovered", {
    lens_count: lenses.length,
    lenses: lenses.map((l) => ({ slug: l.slug, name: l.name }))
  });
  if (lenses.length === 0) {
    throw new Error(
      "Lens discovery returned 0 lenses. Repo may be too sparse for principles extraction. Add docs/manifests and re-run."
    );
  }

  // STEP 3 — extract per-lens patterns in parallel
  const perLensExtractions = await Promise.all(
    lenses.map((lens) => extractPatternsForLens(scan, sourceSample, lens))
  );
  for (const extraction of perLensExtractions) {
    await appendEvent(outDir, "lens_patterns_extracted", {
      lens_slug: extraction.lens_slug,
      positive_count: extraction.positive_patterns.length,
      antipattern_count: extraction.antipatterns.length,
      ambiguity_count: extraction.ambiguities.length
    });
  }

  // STEP 4 — generate interview questions (only when interactive)
  let interviewLog = [];
  if (interactive) {
    const questions = await generateInterviewQuestions(perLensExtractions);
    await appendEvent(outDir, "interview_generated", {
      question_count: questions.length
    });

    if (questions.length === 0) {
      console.log(
        "\nNo ambiguities to resolve — the scan was unambiguous. Skipping interview."
      );
    } else {
      interviewLog = await runInteractiveInterview(questions);
    }
    await appendEvent(outDir, "interview_completed", {
      answered:
        interviewLog.filter((entry) => !entry.skipped).length,
      skipped: interviewLog.filter((entry) => entry.skipped).length
    });
  } else {
    await appendEvent(outDir, "interview_skipped", {
      reason: "non_interactive_mode"
    });
  }

  // STEP 5 — consolidate into final principles
  const rawPrinciples = await consolidatePrinciples({
    lenses,
    perLensExtractions,
    interviewLog
  });
  await appendEvent(outDir, "principles_consolidated", {
    principle_count: rawPrinciples.length,
    by_polarity: {
      do: rawPrinciples.filter((p) => p.polarity === "do").length,
      dont: rawPrinciples.filter((p) => p.polarity === "dont").length
    },
    by_confidence: {
      high: rawPrinciples.filter((p) => p.confidence === "high").length,
      medium: rawPrinciples.filter((p) => p.confidence === "medium").length,
      low: rawPrinciples.filter((p) => p.confidence === "low").length
    }
  });

  // STEP 5b — cite-or-die. LLMs fabricate paths and line numbers; we drop
  // any citation that doesn't resolve to a real file under repoPath. A
  // principle with zero verified citations gets dropped entirely.
  const { principles, summary: citeSummary } = await pruneFabricatedCitations(
    rawPrinciples,
    repoPath
  );
  await appendEvent(outDir, "citations_verified", citeSummary);

  // STEP 6 — emit principles.json + principles.md
  const artifact = {
    version: VERSION,
    source: {
      repo_path: scan.repo_path,
      scanned_at: startedAt,
      interview_completed: interactive && interviewLog.length > 0
    },
    lenses,
    principles,
    interview_log: interviewLog
  };

  const jsonPath = path.join(outDir, "principles.json");
  const mdPath = path.join(outDir, "principles.md");
  await writeJson(jsonPath, artifact);
  const markdown = renderPrinciplesMarkdown(artifact);
  await writeFile(mdPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`);

  await appendEvent(outDir, "principles_emitted", {
    json_path: jsonPath,
    md_path: mdPath
  });

  await appendEvent(outDir, "principles_completed", {
    lens_count: lenses.length,
    principle_count: principles.length,
    interview_answered: interviewLog.filter((entry) => !entry.skipped)
      .length
  });

  return {
    outDir,
    repoPath: scan.repo_path,
    lenses,
    principles,
    interviewLog,
    jsonPath,
    mdPath
  };
}

export { discoverPrinciples };
