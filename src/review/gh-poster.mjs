import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  findPrinciple,
  renderViolationComment
} from "./comment-renderer.mjs";

const execFileAsync = promisify(execFile);

async function ghAvailable() {
  try {
    await execFileAsync("gh", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

// Post a single inline comment via gh API. Uses the pulls/{N}/comments
// endpoint with commit_id + path + line; the underlying GitHub API
// targets the specific line in the right file at the latest commit.
async function postOneComment({
  prNumber,
  owner,
  repo,
  commitId,
  violation,
  principle
}) {
  const body = renderViolationComment(violation, principle);
  const args = [
    "api",
    "--method",
    "POST",
    `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
    "-f",
    `body=${body}`,
    "-f",
    `commit_id=${commitId}`,
    "-f",
    `path=${violation.file}`,
    "-F",
    `line=${violation.line}`,
    "-f",
    "side=RIGHT"
  ];
  await execFileAsync("gh", args, { maxBuffer: 5 * 1024 * 1024 });
}

async function getPrMeta(prNumber) {
  const { stdout } = await execFileAsync("gh", [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "headRefOid,headRepository,headRepositoryOwner,baseRepository,baseRepositoryOwner"
  ]);
  const meta = JSON.parse(stdout);
  // Posting comments goes against the BASE repo (the fork target). Head is
  // where the commit lives, so we still use headRefOid for commit_id.
  return {
    commitId: meta.headRefOid,
    owner:
      meta.baseRepositoryOwner?.login ||
      meta.baseRepository?.owner?.login ||
      meta.headRepositoryOwner?.login,
    repo: meta.baseRepository?.name || meta.headRepository?.name
  };
}

async function postReviewComments({ prNumber, violations, principles }) {
  if (!(await ghAvailable())) {
    throw new Error(
      "gh CLI not found. Install GitHub's gh (https://cli.github.com) and run `gh auth login` to post review comments."
    );
  }
  const meta = await getPrMeta(prNumber);
  let posted = 0;
  const failures = [];
  for (const v of violations) {
    const principle = findPrinciple(principles, v.principle_id);
    if (!principle) continue;
    try {
      await postOneComment({
        prNumber,
        owner: meta.owner,
        repo: meta.repo,
        commitId: meta.commitId,
        violation: v,
        principle
      });
      posted += 1;
    } catch (error) {
      failures.push({ violation: v, error: String(error?.message || error) });
    }
  }
  return { posted, failures };
}

// Batched review (#12) — one API call to POST /pulls/<N>/reviews with all
// inline comments attached + a summary body. Saves rate-limit budget vs
// the one-by-one path and lands as a single review event on the PR
// timeline. The non-interactive / CI path.
async function postBatchedReview({
  prNumber,
  violations,
  principles,
  event = "COMMENT"
}) {
  if (!(await ghAvailable())) {
    throw new Error(
      "gh CLI not found. Install GitHub's gh and run `gh auth login`."
    );
  }
  if (!["COMMENT", "REQUEST_CHANGES", "APPROVE"].includes(event)) {
    throw new Error(
      `Invalid --event: ${event}. Expected COMMENT, REQUEST_CHANGES, or APPROVE.`
    );
  }
  const meta = await getPrMeta(prNumber);

  const comments = [];
  for (const v of violations) {
    const principle = findPrinciple(principles, v.principle_id);
    if (!principle) continue;
    comments.push({
      path: v.file,
      line: v.line,
      side: "RIGHT",
      body: renderViolationComment(v, principle)
    });
  }

  if (comments.length === 0) {
    return { posted: 0, failures: [], skipped_empty: true };
  }

  const byCounts = violations.reduce(
    (a, v) => ({ ...a, [v.severity]: (a[v.severity] || 0) + 1 }),
    {}
  );
  const summary = [
    `**adr review**: ${violations.length} principle violation${violations.length === 1 ? "" : "s"} found.`,
    "",
    `Severity: high=${byCounts.high || 0}, medium=${byCounts.medium || 0}, low=${byCounts.low || 0}.`,
    "",
    "Each comment cites the team's own file:line as the example to follow. Suppress with `// adr-ignore: <principle-id>`."
  ].join("\n");

  const payload = {
    commit_id: meta.commitId,
    body: summary,
    event,
    comments
  };

  // Write payload to a temp file and pass via `--input` so multiline body
  // doesn't run afoul of shell escaping.
  const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const tmpDir = await mkdtemp(path.join(tmpdir(), "adr-review-batch-"));
  const payloadPath = path.join(tmpDir, "payload.json");
  await writeFile(payloadPath, JSON.stringify(payload));

  try {
    await execFileAsync(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `repos/${meta.owner}/${meta.repo}/pulls/${prNumber}/reviews`,
        "--input",
        payloadPath
      ],
      { maxBuffer: 5 * 1024 * 1024 }
    );
    return { posted: comments.length, failures: [], batched: true };
  } catch (error) {
    return {
      posted: 0,
      failures: [{ error: String(error?.message || error) }],
      batched: true
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export { postReviewComments, postBatchedReview, ghAvailable };
