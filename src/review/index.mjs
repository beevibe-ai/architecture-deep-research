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
import { loadDiff } from "./diff-loader.mjs";
import { parseDiff } from "./hunk-parser.mjs";
import { detectViolations } from "./violation-detector.mjs";
import {
  findPrinciple,
  rankViolations,
  renderViolationForTerminal
} from "./comment-renderer.mjs";
import { runInteractiveWalkthrough } from "./interactive-walkthrough.mjs";
import { postReviewComments } from "./gh-poster.mjs";

function assertReviewRuntime() {
  const llm = activeLlmProvider();
  if (!llm) {
    throw new Error(
      "No LLM provider configured. Set ADR_OPENAI_API_KEY or OPENAI_API_KEY before running `adr review`."
    );
  }
  return { llmProvider: llm };
}

async function readPrinciples(principlesPath) {
  let raw;
  try {
    raw = await readFile(principlesPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `principles.json not found at ${principlesPath}. Run \`adr principles init\` first to discover this team's principles.`
      );
    }
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.principles) || parsed.principles.length === 0) {
    throw new Error(
      `${principlesPath} has no principles. Re-run \`adr principles init\` and ensure the interview produced at least one confirmed principle.`
    );
  }
  return parsed;
}

function resolveSource(inputPath, flags) {
  // CLI shape:
  //   adr review <PR#>           → pr
  //   adr review --diff <path>   → file (or stdin if value === "-")
  //   adr review --staged        → staged
  //   adr review --branch <base> → branch (default base: main)
  if (flags.staged === true || flags.staged === "true") {
    return { kind: "staged", value: null };
  }
  if (typeof flags.diff === "string" && flags.diff.length > 0) {
    return { kind: "file", value: flags.diff };
  }
  if (typeof flags.branch === "string" && flags.branch.length > 0) {
    return { kind: "branch", value: flags.branch };
  }
  if (inputPath && /^\d+$/.test(String(inputPath))) {
    return { kind: "pr", value: Number(inputPath) };
  }
  throw new Error(
    "adr review needs one of: <PR#>, --diff <path> (or -), --staged, --branch <base>."
  );
}

async function reviewDiff({ inputPath, flags = {} } = {}) {
  const repoPath = path.resolve(flags.repo || ".");
  const principlesPath = path.resolve(
    flags.principles || path.join(repoPath, ".adr", "principles.json")
  );
  const outDir = path.resolve(
    flags.out || path.join(repoPath, ".adr", "reviews")
  );
  const interactive = flags["non-interactive"] !== true;
  const post = flags.post === true || flags.post === "true";
  const topN = Number.isFinite(Number(flags["top-n"]))
    ? Number(flags["top-n"])
    : null;

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "events.jsonl"), "");
  resetLlmCost();

  const runtime = assertReviewRuntime();
  const startedAt = nowIso();
  const source = resolveSource(inputPath, flags);

  await appendEvent(outDir, "review_started", {
    runtime,
    repo_path: repoPath,
    principles_path: principlesPath,
    source,
    interactive,
    post
  });

  const principlesArtifact = await readPrinciples(principlesPath);
  const principles = principlesArtifact.principles;
  await appendEvent(outDir, "principles_loaded", {
    principle_count: principles.length,
    lens_count: principlesArtifact.lenses?.length || 0
  });

  const rawDiff = await loadDiff({
    source: source.kind,
    value: source.value,
    cwd: repoPath
  });
  const files = parseDiff(rawDiff);
  const filesReviewed = files
    .filter((f) => !f.binary && f.hunks.length > 0)
    .map((f) => f.new_path);
  await appendEvent(outDir, "diff_parsed", {
    file_count: filesReviewed.length,
    binary_skipped: files.filter((f) => f.binary).length,
    bytes: Buffer.byteLength(rawDiff, "utf8")
  });

  if (filesReviewed.length === 0) {
    await appendEvent(outDir, "review_completed", {
      violations: 0,
      note: "no_text_files_in_diff"
    });
    console.log("No text files changed — nothing to review.");
    return { violations: [], filesReviewed: [] };
  }

  const rawViolations = await detectViolations(files, principles);
  const ranked = rankViolations(rawViolations);
  const capped = topN != null && topN > 0 ? ranked.slice(0, topN) : ranked;
  await appendEvent(outDir, "violations_detected", {
    raw_count: rawViolations.length,
    capped_count: capped.length,
    by_severity: {
      high: ranked.filter((v) => v.severity === "high").length,
      medium: ranked.filter((v) => v.severity === "medium").length,
      low: ranked.filter((v) => v.severity === "low").length
    }
  });

  let accepted = capped;
  if (interactive && capped.length > 0) {
    accepted = await runInteractiveWalkthrough(capped, principles);
    await appendEvent(outDir, "walkthrough_completed", {
      accepted: accepted.length,
      dropped: capped.length - accepted.length
    });
  } else if (capped.length === 0) {
    console.log("\nNo principle violations found. Ship it.");
  }

  let postResult = null;
  if (post && accepted.length > 0 && source.kind === "pr") {
    try {
      postResult = await postReviewComments({
        prNumber: source.value,
        violations: accepted,
        principles
      });
      await appendEvent(outDir, "comments_posted", postResult);
      console.log(
        `\nPosted ${postResult.posted} of ${accepted.length} comments to PR #${source.value}.`
      );
      if (postResult.failures.length > 0) {
        console.log(
          `${postResult.failures.length} failed — see events.jsonl for detail.`
        );
      }
    } catch (error) {
      await appendEvent(outDir, "comments_post_failed", {
        error: String(error?.message || error)
      });
      console.error(`\nPosting failed: ${error.message}`);
    }
  } else if (!interactive && accepted.length > 0) {
    // Non-interactive + no --post: print to stdout for CI to read.
    for (let i = 0; i < accepted.length; i += 1) {
      const v = accepted[i];
      const p = findPrinciple(principles, v.principle_id);
      if (!p) continue;
      console.log(renderViolationForTerminal(v, p, i, accepted.length));
      console.log("");
    }
  }

  const artifact = {
    version: VERSION,
    source: {
      kind: source.kind,
      value: source.value,
      loaded_at: startedAt
    },
    principles_path: principlesPath,
    files_reviewed: filesReviewed,
    violations: accepted,
    ...(postResult ? { post_result: postResult } : {})
  };

  // Latest run only. events.jsonl is the audit log; the JSON is the
  // current state for the slash command / CI consumer to read.
  const reviewJsonPath = path.join(outDir, "review.json");
  await writeJson(reviewJsonPath, artifact);
  await appendEvent(outDir, "review_completed", {
    artifact_path: reviewJsonPath,
    violation_count: accepted.length
  });

  return {
    outDir,
    violations: accepted,
    filesReviewed,
    artifactPath: reviewJsonPath,
    postResult
  };
}

export { reviewDiff };
