import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { sampleRepoSource, sampleChangedFilesSince } from "./source-sampler.mjs";
import { discoverLenses } from "./lens-discovery.mjs";
import { extractPatternsForLens } from "./pattern-extractor.mjs";
import {
  generateInterviewQuestions,
  runInteractiveInterview
} from "./interview.mjs";
import { consolidatePrinciples } from "./consolidator.mjs";
import { pruneFabricatedCitations } from "./cite-verifier.mjs";
import { mergePrinciples } from "./refresh-merge.mjs";
import {
  applyStatsToConfidence,
  loadStatsForEvolution
} from "./confidence-evolution.mjs";
import { extractProductIntent } from "./product-intent.mjs";
import { extractRichComments } from "./comment-extractor.mjs";
import { extractTestDescriptors } from "./test-descriptor-extractor.mjs";
import { extractGitHubSignals } from "./github-signals.mjs";
import { renderPrinciplesMarkdown } from "./render-markdown.mjs";
import { renderPrinciplesHtml } from "../render/principles-html.mjs";

// Build a progress reporter that writes to stderr (visible when run as
// a CLI / piped through tee) AND optionally invokes an onProgress
// callback (used by the MCP handler to forward as notifications). The
// MCP server process's stderr is captured but not shown mid-call by
// Claude Code, so the callback is what makes progress visible in the
// chat UI.
function buildProgress(onProgress) {
  return function progress(label, detail) {
    const stamp = new Date().toISOString().slice(11, 19);
    const right = detail ? `  \x1b[2m${detail}\x1b[0m` : "";
    process.stderr.write(
      `  \x1b[2m${stamp}\x1b[0m  \x1b[36m${label}\x1b[0m${right}\n`
    );
    if (typeof onProgress === "function") {
      try {
        onProgress({ label, detail: detail || "" });
      } catch {
        // Never let a progress callback failure abort the pipeline.
      }
    }
  };
}

function assertPrinciplesRuntime() {
  const llm = activeLlmProvider();
  if (!llm) {
    throw new Error(
      "No LLM provider configured. Set ADR_OPENAI_API_KEY or OPENAI_API_KEY before running `adr principles init`."
    );
  }
  return { llmProvider: llm };
}

async function readPriorArtifact(outDir) {
  try {
    const raw = await readFile(path.join(outDir, "principles.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function discoverPrinciples({ flags = {}, onProgress } = {}) {
  const progress = buildProgress(onProgress);
  const repoPath = path.resolve(flags.repo || ".");
  const outDir = path.resolve(flags.out || path.join(repoPath, ".adr"));
  const interactive = flags["non-interactive"] !== true;
  const refresh = flags.refresh === true || flags.refresh === "true";
  const incremental =
    flags.incremental === true || flags.incremental === "true";

  // Incremental implies refresh — it reads prior + only re-extracts on
  // changed files, then merges. Treat as a stricter mode of refresh.
  const needsPrior = refresh || incremental;

  await mkdir(outDir, { recursive: true });

  // Read prior artifact BEFORE truncating events.jsonl. Refresh/incremental
  // mode requires it; init mode ignores it (the new run wins).
  const priorArtifact = needsPrior ? await readPriorArtifact(outDir) : null;
  if (needsPrior && !priorArtifact) {
    const mode = incremental ? "incremental" : "refresh";
    throw new Error(
      `adr principles ${mode} requires an existing principles.json in ${outDir}. Run \`adr principles init\` first.`
    );
  }
  const priorInterviewLog = Array.isArray(priorArtifact?.interview_log)
    ? priorArtifact.interview_log
    : [];
  const priorPrinciples = Array.isArray(priorArtifact?.principles)
    ? priorArtifact.principles
    : [];
  const priorLenses = Array.isArray(priorArtifact?.lenses)
    ? priorArtifact.lenses
    : [];
  const priorScannedAt = priorArtifact?.source?.scanned_at || null;

  await writeFile(path.join(outDir, "events.jsonl"), "");
  resetLlmCost();

  const runtime = assertPrinciplesRuntime();
  const startedAt = nowIso();

  const mode = incremental ? "incremental" : refresh ? "refresh" : "init";
  await appendEvent(outDir, "principles_started", {
    runtime,
    repo_path: repoPath,
    out_dir: outDir,
    interactive,
    mode,
    prior_principle_count: priorPrinciples.length,
    prior_interview_log_count: priorInterviewLog.length
  });
  process.stderr.write(
    `\n\x1b[1madr principles\x1b[0m  \x1b[2m(${mode} mode, ~2-4 min, ~$0.15)\x1b[0m\n\n`
  );
  if (typeof onProgress === "function") {
    try {
      onProgress({
        label: "adr principles started",
        detail: `${mode} mode, ~2-4 min, ~$0.15`
      });
    } catch {}
  }

  // STEP 1 — deterministic scan (no LLM, reused from discover/)
  progress("scanning repo", "");
  const scan = await scanRepo(repoPath);
  progress(
    "✓ scanned",
    `${scan.summary.file_count} files, ${scan.summary.doc_count} docs, ${scan.summary.manifest_count} manifests`
  );
  await appendEvent(outDir, "repo_scanned", { ...scan.summary });

  // STEP 1b — sample real source code so lens discovery and extraction can
  // cite actual lines, not invented ones. In incremental mode, only
  // sample files changed since the last refresh — the rest of the repo
  // is already represented by prior principles.
  const sourceSample = incremental
    ? await sampleChangedFilesSince(repoPath, priorScannedAt)
    : await sampleRepoSource(repoPath);
  progress(
    "✓ sampled source",
    incremental
      ? `${sourceSample.summary.total_files} files (of ${sourceSample.summary.changed_total} changed since ${priorScannedAt})`
      : `${sourceSample.summary.total_files} files across ${sourceSample.summary.top_levels.length} top-level dirs`
  );
  await appendEvent(outDir, "source_sampled", {
    sample_count: sourceSample.summary.total_files,
    top_levels: sourceSample.summary.top_levels,
    mode,
    ...(incremental
      ? { since: sourceSample.summary.since, changed_total: sourceSample.summary.changed_total }
      : {})
  });

  // STEP 1c — enrich signals (deterministic, no LLM). Three sources:
  //   - rich comments    : marker bodies + rationale/prohibition/header/JSDoc
  //   - test descriptors : describe/it/test names as executable invariants
  //   - github signals   : closed wontfix issues + arch-keyword merged PRs
  //                        (best-effort; skipped if gh CLI or origin missing)
  progress("collecting comments + tests + github signals", "");
  const [richComments, testDescriptors, githubSignals] = await Promise.all([
    extractRichComments(sourceSample),
    extractTestDescriptors(repoPath),
    extractGitHubSignals({ repoPath })
  ]);
  scan.rich_comments = richComments;
  scan.test_descriptors = testDescriptors;
  scan.github_signals = githubSignals;
  progress(
    "✓ enriched signals",
    `${richComments.summary.marker_count} markers, ${richComments.summary.rationale_count} rationales, ${richComments.summary.prohibition_count} prohibitions, ${richComments.summary.jsdoc_count} jsdoc, ${testDescriptors.summary.descriptor_count} test names${
      githubSignals.available
        ? `, ${githubSignals.summary.rejected_issue_count} rejected issues, ${githubSignals.summary.arch_keyword_pr_count} arch PRs`
        : ` (github skipped: ${githubSignals.summary.reason})`
    }`
  );
  await appendEvent(outDir, "signals_enriched", {
    rich_comments: richComments.summary,
    test_descriptors: testDescriptors.summary,
    github_signals: githubSignals.summary
  });

  // Incremental shortcut: if no files have changed, skip the rest and
  // just carry forward the prior artifact (with refreshed events.jsonl).
  if (incremental && sourceSample.samples.length === 0) {
    await appendEvent(outDir, "incremental_no_changes", {
      since: priorScannedAt
    });
    await appendEvent(outDir, "principles_completed", {
      lens_count: priorLenses.length,
      principle_count: priorPrinciples.length,
      interview_answered: 0,
      no_changes: true
    });
    return {
      outDir,
      repoPath,
      lenses: priorLenses,
      principles: priorPrinciples,
      interviewLog: priorInterviewLog,
      jsonPath: path.join(outDir, "principles.json"),
      mdPath: path.join(outDir, "principles.md"),
      noChanges: true
    };
  }

  // STEP 1c — product intent. The "what is this product" pass. Runs in
  // parallel with lens discovery (different LLM calls, no shared state).
  // Refresh + incremental preserve prior intent unless --reset-intent.
  const resetIntent =
    flags["reset-intent"] === true || flags["reset-intent"] === "true";
  const priorIntent = priorArtifact?.product_intent || null;
  let productIntent;
  let lenses;
  const shouldDeriveIntent =
    !priorIntent || resetIntent || mode === "init";

  if (shouldDeriveIntent) {
    progress("extracting product intent + discovering lenses", "(LLM, parallel)");
    const [intentResult, lensResult] = await Promise.all([
      extractProductIntent(scan, sourceSample),
      incremental ? Promise.resolve(priorLenses) : discoverLenses(scan, sourceSample)
    ]);
    productIntent = intentResult;
    lenses = lensResult;
    progress(
      "✓ product intent",
      `${productIntent.architectural_intent.length} architectural decisions, ${productIntent.product_philosophy.length} philosophy items, ${productIntent.non_goals.length} non-goals`
    );
    progress(
      "✓ lenses discovered",
      lenses.map((l) => l.slug).join(", ")
    );
  } else {
    progress("discovering lenses", "(LLM)");
    lenses = incremental
      ? priorLenses
      : await discoverLenses(scan, sourceSample);
    productIntent = priorIntent;
    progress("✓ lenses discovered", lenses.map((l) => l.slug).join(", "));
    progress(
      "✓ product intent",
      `carried forward from prior (use --reset-intent to re-derive)`
    );
  }

  await appendEvent(outDir, "product_intent_extracted", {
    identity_present: Boolean(productIntent.identity),
    architectural_count: productIntent.architectural_intent.length,
    philosophy_count: productIntent.product_philosophy.length,
    non_goals_count: productIntent.non_goals.length,
    carried_forward: !shouldDeriveIntent
  });
  await appendEvent(outDir, "lenses_discovered", {
    lens_count: lenses.length,
    lenses: lenses.map((l) => ({ slug: l.slug, name: l.name })),
    reused_from_prior: incremental
  });
  if (lenses.length === 0) {
    throw new Error(
      "Lens discovery returned 0 lenses. Repo may be too sparse for principles extraction. Add docs/manifests and re-run."
    );
  }

  // STEP 3 — extract per-lens patterns in parallel
  progress(
    `extracting patterns`,
    `${lenses.length} lenses in parallel (LLM)`
  );
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
  const totalPatterns = perLensExtractions.reduce(
    (n, e) => n + e.positive_patterns.length + e.antipatterns.length,
    0
  );
  progress(
    "✓ patterns extracted",
    `${totalPatterns} across ${lenses.length} lenses`
  );

  // STEP 4 — generate interview questions (only when interactive). In
  // refresh mode, the generator gets the prior log so it can skip
  // questions whose answers we already have.
  let newInterviewLog = [];
  if (interactive) {
    const questions = await generateInterviewQuestions(perLensExtractions, {
      priorInterviewLog
    });
    await appendEvent(outDir, "interview_generated", {
      question_count: questions.length,
      mode: refresh ? "refresh" : "init"
    });

    if (questions.length === 0) {
      console.log(
        refresh
          ? "\nNo new ambiguities since the last refresh. Carrying prior answers forward."
          : "\nNo ambiguities to resolve — the scan was unambiguous. Skipping interview."
      );
    } else {
      newInterviewLog = await runInteractiveInterview(questions);
    }
    await appendEvent(outDir, "interview_completed", {
      answered:
        newInterviewLog.filter((entry) => !entry.skipped).length,
      skipped: newInterviewLog.filter((entry) => entry.skipped).length
    });
  } else {
    await appendEvent(outDir, "interview_skipped", {
      reason: "non_interactive_mode"
    });
  }
  // Final interview log = prior + new. The consolidator uses BOTH so prior
  // confirmed-by-interview principles stay confirmed.
  const interviewLog = [...priorInterviewLog, ...newInterviewLog];

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
  const { principles: prunedPrinciples, summary: citeSummary } =
    await pruneFabricatedCitations(rawPrinciples, repoPath);
  await appendEvent(outDir, "citations_verified", citeSummary);

  // STEP 5c — refresh-merge: inherit confirmed_by_interview + confidence
  // from prior principles whose citations overlap (by filename) with the
  // new ones. Init mode skips this (priorPrinciples is empty). Incremental
  // mode REQUIRES it — otherwise the unchanged areas of the repo lose
  // their principles.
  let principles = prunedPrinciples;
  if ((refresh || incremental) && priorPrinciples.length > 0) {
    // In incremental mode, also include prior principles whose evidence
    // lives entirely OUTSIDE the changed sample — they're still valid,
    // they just weren't re-extracted this run.
    let merged;
    let mergeStats;
    if (incremental) {
      const changedFilenames = new Set(
        sourceSample.samples.map((s) => s.path)
      );
      const untouchedPriorPrinciples = priorPrinciples.filter((p) => {
        const cites = (p.evidence_cite || [])
          .map((c) => c.split(":")[0])
          .filter(Boolean);
        if (cites.length === 0) return false;
        return cites.every((cite) => !changedFilenames.has(cite));
      });
      const result = mergePrinciples(
        [...prunedPrinciples, ...untouchedPriorPrinciples],
        priorPrinciples
      );
      merged = result.merged;
      mergeStats = {
        ...result.stats,
        untouched_carried_forward: untouchedPriorPrinciples.length
      };
    } else {
      const result = mergePrinciples(prunedPrinciples, priorPrinciples);
      merged = result.merged;
      mergeStats = result.stats;
    }
    principles = merged;
    await appendEvent(outDir, "refresh_merged", mergeStats);
  }

  // STEP 5d — confidence evolution: read principle-stats.json (built by
  // `adr review` over time) and override confidence based on real usage.
  // Principles with >=50% recent skip rate get demoted to "low".
  // Principles with >=80% recent accept rate get promoted to "high".
  // This is the loop that prevents static-lint drift — a principle that
  // fires 20x and gets skipped 18x doesn't stay confident.
  const statsArtifact = await loadStatsForEvolution(outDir);
  if (statsArtifact) {
    const { principles: evolved, changes } = applyStatsToConfidence(
      principles,
      statsArtifact
    );
    principles = evolved;
    await appendEvent(outDir, "confidence_evolved", {
      changes,
      change_count: changes.length
    });
  }

  // STEP 6 — emit principles.json + principles.md
  progress("writing principles.{md,json}", "");
  const artifact = {
    version: VERSION,
    source: {
      repo_path: scan.repo_path,
      scanned_at: startedAt,
      interview_completed: interactive && interviewLog.length > 0,
      ...(mode !== "init"
        ? {
            mode,
            prior_principle_count: priorPrinciples.length
          }
        : {})
    },
    product_intent: productIntent,
    lenses,
    principles,
    interview_log: interviewLog
  };

  const jsonPath = path.join(outDir, "principles.json");
  const mdPath = path.join(outDir, "principles.md");
  await writeJson(jsonPath, artifact);
  const markdown = renderPrinciplesMarkdown(artifact);
  await writeFile(mdPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`);

  // Beautifully-rendered, interactive HTML report — leads with the
  // product portrait, includes a code map, filters by lens/polarity/
  // confidence, links each citation to vscode://. Sits next to the
  // markdown for users who want the rich view.
  const htmlPath = await renderPrinciplesHtml({ outDir });

  await appendEvent(outDir, "principles_emitted", {
    json_path: jsonPath,
    md_path: mdPath,
    html_path: htmlPath
  });

  await appendEvent(outDir, "principles_completed", {
    lens_count: lenses.length,
    principle_count: principles.length,
    interview_answered: interviewLog.filter((entry) => !entry.skipped)
      .length
  });

  progress(
    "✓ done",
    `${lenses.length} lenses, ${principles.length} principles, ${productIntent.architectural_intent.length} architectural intents`
  );

  return {
    outDir,
    repoPath: scan.repo_path,
    lenses,
    productIntent,
    principles,
    interviewLog,
    jsonPath,
    mdPath,
    htmlPath
  };
}

export { discoverPrinciples };
