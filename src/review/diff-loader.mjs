import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_DIFF_BYTES = 200_000;

function tooLargeError(bytes) {
  return new Error(
    `Diff is ${bytes} bytes — too large for a single review pass (cap: ${MAX_DIFF_BYTES}). Break the change into smaller PRs or pass a narrower diff via --diff <path>.`
  );
}

async function loadFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function loadFromFile(filePath) {
  return readFile(filePath, "utf8");
}

async function loadFromStaged({ cwd }) {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--staged", "--unified=5"],
    { cwd, maxBuffer: 50 * 1024 * 1024 }
  );
  return stdout;
}

async function loadFromBranch({ cwd, base }) {
  const baseBranch = base || "main";
  const { stdout } = await execFileAsync(
    "git",
    ["diff", `${baseBranch}...HEAD`, "--unified=5"],
    { cwd, maxBuffer: 50 * 1024 * 1024 }
  );
  return stdout;
}

async function loadFromPr({ prNumber, cwd }) {
  // `gh pr diff <N>` includes the unified diff with adequate context. If gh
  // is missing or not authenticated, surface the underlying error — the user
  // needs to fix that before the review can run.
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "diff", String(prNumber)],
      { cwd, maxBuffer: 50 * 1024 * 1024 }
    );
    return stdout;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "gh CLI not found. Install GitHub's gh (https://cli.github.com) and run `gh auth login` to review PRs."
      );
    }
    throw error;
  }
}

async function loadDiff({ source, value, cwd = process.cwd() } = {}) {
  let raw;
  if (source === "pr") {
    raw = await loadFromPr({ prNumber: value, cwd });
  } else if (source === "staged") {
    raw = await loadFromStaged({ cwd });
  } else if (source === "branch") {
    raw = await loadFromBranch({ cwd, base: value });
  } else if (source === "file") {
    if (!value || value === "-") {
      raw = await loadFromStdin();
    } else {
      raw = await loadFromFile(value);
    }
  } else {
    throw new Error(
      `Unknown diff source: ${source}. Expected one of: pr, staged, branch, file.`
    );
  }

  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > MAX_DIFF_BYTES) throw tooLargeError(bytes);
  if (raw.trim().length === 0) {
    throw new Error(
      `${source === "pr" ? `PR #${value}` : source} produced an empty diff. Nothing to review.`
    );
  }
  return raw;
}

export { loadDiff, MAX_DIFF_BYTES };
