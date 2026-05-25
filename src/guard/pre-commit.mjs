import path from "node:path";
import { stat } from "node:fs/promises";

import { reviewDiff } from "./kernel-bridge.mjs";

// Run `adr review --staged --non-interactive --top-n 5`. Exit non-zero only
// when at least one HIGH-severity violation lands; medium/low are advisory.
// This makes the pre-commit hook strict on the rules the team confirmed,
// permissive on edge cases.
async function runPreCommitHook({ repoPath = process.cwd(), failOn = "high" } = {}) {
  const principlesPath = path.join(repoPath, ".adr", "principles.json");
  try {
    await stat(principlesPath);
  } catch {
    // No principles file — quietly allow the commit. We don't want
    // commits to be blocked just because someone hasn't run principles
    // init yet.
    return { status: "no_principles", blocked: false };
  }

  const result = await reviewDiff({
    flags: {
      repo: repoPath,
      staged: true,
      "non-interactive": true,
      "top-n": "5"
    }
  });

  const blockingViolations = result.violations.filter((v) => {
    if (failOn === "high") return v.severity === "high";
    if (failOn === "medium") return v.severity !== "low";
    return false;
  });

  if (blockingViolations.length === 0) {
    if (result.violations.length > 0) {
      console.log(
        `\nadr guard: ${result.violations.length} advisory violation(s) (medium/low). Commit proceeding.`
      );
    }
    return { status: "passed", blocked: false, advisory_count: result.violations.length };
  }

  console.log("");
  console.log(
    `adr guard: blocked commit on ${blockingViolations.length} ${failOn}-severity violation(s).`
  );
  console.log(
    `Run \`adr review --staged\` to walk through them, or bypass with \`git commit --no-verify\` if you must.`
  );
  console.log("");
  return {
    status: "blocked",
    blocked: true,
    blocking_count: blockingViolations.length,
    violations: blockingViolations
  };
}

export { runPreCommitHook };
