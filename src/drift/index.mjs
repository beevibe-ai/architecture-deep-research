// `adr drift` — full-repo scan against `.adr/principles.json`. Different
// from `adr review`: review checks a diff (incoming change); drift checks
// the entire codebase at HEAD against the principles you discovered N
// weeks ago. Useful for "how far has reality drifted from the plan?"

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
import { walkAllSourceFiles } from "../principles/source-sampler.mjs";
import { detectViolationsForFile } from "../review/violation-detector.mjs";
import { rankViolations } from "../review/comment-renderer.mjs";

function assertRuntime() {
  if (!activeLlmProvider()) {
    throw new Error(
      "No LLM provider configured. Set ADR_OPENAI_API_KEY or OPENAI_API_KEY before `adr drift`."
    );
  }
}

// Build a synthetic "file" object the violation-detector expects, with
// every line tagged as `kind: 'add'` so it gets surfaced for review. The
// LLM treats every line as in-scope.
function fileSampleToHunk(sample) {
  const lines = sample.content.split("\n");
  const hunkLines = lines.map((text, idx) => ({
    kind: "add",
    new_line: idx + 1,
    text
  }));
  return {
    new_path: sample.path,
    binary: false,
    hunks: [
      {
        new_start: 1,
        new_count: hunkLines.length,
        section: "",
        lines: hunkLines
      }
    ]
  };
}

async function runDrift({ flags = {} } = {}) {
  assertRuntime();
  const repoPath = path.resolve(flags.repo || ".");
  const outDir = path.resolve(flags.out || path.join(repoPath, ".adr"));
  const principlesPath = path.resolve(
    flags.principles || path.join(outDir, "principles.json")
  );
  const maxFiles = Number.isFinite(Number(flags["max-files"]))
    ? Number(flags["max-files"])
    : 100;
  const concurrency = Number.isFinite(Number(flags.concurrency))
    ? Number(flags.concurrency)
    : 5;
  const driftOutDir = path.join(outDir, "drift");

  await mkdir(driftOutDir, { recursive: true });
  await writeFile(path.join(driftOutDir, "events.jsonl"), "");
  resetLlmCost();

  let principlesArtifact;
  try {
    principlesArtifact = JSON.parse(await readFile(principlesPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `principles.json not found at ${principlesPath}. Run \`adr principles init\` first.`
      );
    }
    throw error;
  }
  const principles = principlesArtifact.principles || [];
  if (principles.length === 0) {
    throw new Error(
      `${principlesPath} has no principles. Re-run \`adr principles init\`.`
    );
  }

  const startedAt = nowIso();
  await appendEvent(driftOutDir, "drift_started", {
    repo_path: repoPath,
    principles_path: principlesPath,
    principle_count: principles.length,
    max_files: maxFiles,
    concurrency
  });

  const samples = await walkAllSourceFiles(repoPath, { maxFiles });
  await appendEvent(driftOutDir, "files_collected", {
    file_count: samples.length
  });

  if (samples.length === 0) {
    await appendEvent(driftOutDir, "drift_completed", {
      violation_count: 0,
      note: "no_source_files"
    });
    return { outDir: driftOutDir, violations: [] };
  }

  // Parallel-bounded LLM calls. detectViolationsForFile is one call per
  // file; we cap concurrency so we don't fan out 100+ requests at once.
  const violations = [];
  let cursor = 0;
  let processed = 0;
  const workers = Array.from({ length: Math.min(concurrency, samples.length) }, async () => {
    while (cursor < samples.length) {
      const idx = cursor;
      cursor += 1;
      const sample = samples[idx];
      const file = fileSampleToHunk(sample);
      try {
        const found = await detectViolationsForFile(file, principles);
        for (const v of found) violations.push(v);
      } catch (error) {
        await appendEvent(driftOutDir, "file_scan_failed", {
          file: sample.path,
          error: String(error?.message || error)
        });
      }
      processed += 1;
      if (processed % 10 === 0) {
        await appendEvent(driftOutDir, "drift_progress", {
          processed,
          total: samples.length,
          violations_so_far: violations.length
        });
      }
    }
  });
  await Promise.all(workers);

  const ranked = rankViolations(violations);
  await appendEvent(driftOutDir, "violations_detected", {
    raw_count: violations.length,
    by_severity: {
      high: ranked.filter((v) => v.severity === "high").length,
      medium: ranked.filter((v) => v.severity === "medium").length,
      low: ranked.filter((v) => v.severity === "low").length
    }
  });

  const artifact = {
    version: VERSION,
    source: {
      repo_path: repoPath,
      principles_path: principlesPath,
      scanned_at: startedAt,
      files_scanned: samples.length
    },
    principle_count: principles.length,
    violations: ranked
  };
  const driftJsonPath = path.join(driftOutDir, "drift-report.json");
  await writeJson(driftJsonPath, artifact);

  await appendEvent(driftOutDir, "drift_completed", {
    artifact_path: driftJsonPath,
    violation_count: ranked.length
  });

  // Concise summary to stdout
  console.log("");
  console.log(
    `Drift scan: ${samples.length} files, ${principles.length} principles, ${ranked.length} violations.`
  );
  const by = ranked.reduce(
    (acc, v) => ({ ...acc, [v.severity]: (acc[v.severity] || 0) + 1 }),
    {}
  );
  if (ranked.length > 0) {
    console.log(
      `  severity: high=${by.high || 0}, medium=${by.medium || 0}, low=${by.low || 0}`
    );
  }
  console.log(`Report: ${driftJsonPath}`);

  return {
    outDir: driftOutDir,
    violations: ranked,
    artifactPath: driftJsonPath
  };
}

export { runDrift };
