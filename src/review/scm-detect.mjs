import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Detect which SCM hosts the current repo, so adr review can pull PR
// diffs and post comments without the user having to remember a flag.
// Looks at `git remote get-url origin`. If the user has a different
// origin (a non-PR remote), they can override via --scm.

const HOST_MAP = [
  { pattern: /github\.com/i, scm: "github" },
  { pattern: /gitlab\.com|gitlab\./i, scm: "gitlab" },
  { pattern: /bitbucket\.org|bitbucket\./i, scm: "bitbucket" }
];

async function detectScm(repoPath) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: repoPath, maxBuffer: 1024 * 1024 }
    );
    const url = stdout.trim();
    for (const { pattern, scm } of HOST_MAP) {
      if (pattern.test(url)) return { scm, origin_url: url };
    }
    return { scm: null, origin_url: url };
  } catch {
    return { scm: null, origin_url: null };
  }
}

function resolveScm({ flagScm, detected }) {
  if (flagScm) {
    const lowered = String(flagScm).toLowerCase();
    if (!["github", "gitlab", "bitbucket"].includes(lowered)) {
      throw new Error(
        `Unknown --scm: ${flagScm}. Expected one of github, gitlab, bitbucket.`
      );
    }
    return lowered;
  }
  if (detected?.scm) return detected.scm;
  return "github"; // default — most common; emit a warning if posting fails
}

export { detectScm, resolveScm };
