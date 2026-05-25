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

export { postReviewComments, ghAvailable };
