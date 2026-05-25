// Bitbucket Cloud pull-request inline-comment poster. The official `bb`
// CLI (atlassian-labs/bb) has limited inline-comment support, so we use
// curl + BITBUCKET_TOKEN (or BB_TOKEN) for the API call directly.
// Mirrors gh-poster.mjs's contract.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  findPrinciple,
  renderViolationComment
} from "./comment-renderer.mjs";

const execFileAsync = promisify(execFile);

function bbToken() {
  return process.env.BB_TOKEN || process.env.BITBUCKET_TOKEN || null;
}

async function bbAvailable() {
  if (!bbToken()) return false;
  try {
    await execFileAsync("curl", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

// Parse the repo's bitbucket origin URL into (workspace, repo_slug).
async function parseBitbucketSlug(cwd) {
  const { stdout } = await execFileAsync(
    "git",
    ["remote", "get-url", "origin"],
    { cwd }
  );
  const url = stdout.trim();
  const m = url.match(/bitbucket\.org[:/]([^/]+)\/([^/.]+)/);
  if (!m) {
    throw new Error(
      `Could not parse Bitbucket workspace/repo from origin URL: ${url}`
    );
  }
  return { workspace: m[1], repo_slug: m[2] };
}

async function postOneComment({
  workspace,
  repoSlug,
  prId,
  violation,
  principle,
  token
}) {
  const body = renderViolationComment(violation, principle);
  const payload = {
    content: { raw: body },
    inline: {
      to: violation.line,
      path: violation.file
    }
  };
  const args = [
    "-sS",
    "-X",
    "POST",
    "-H",
    "Content-Type: application/json",
    "-H",
    `Authorization: Bearer ${token}`,
    "-d",
    JSON.stringify(payload),
    `https://api.bitbucket.org/2.0/repositories/${workspace}/${repoSlug}/pullrequests/${prId}/comments`
  ];
  await execFileAsync("curl", args, { maxBuffer: 5 * 1024 * 1024 });
}

async function postReviewComments({
  prId,
  violations,
  principles,
  cwd = process.cwd()
}) {
  if (!(await bbAvailable())) {
    throw new Error(
      "Bitbucket posting needs BB_TOKEN (or BITBUCKET_TOKEN) env var with `pullrequest:write` scope, plus curl available on PATH."
    );
  }
  const { workspace, repo_slug: repoSlug } = await parseBitbucketSlug(cwd);
  const token = bbToken();
  let posted = 0;
  const failures = [];
  for (const v of violations) {
    const principle = findPrinciple(principles, v.principle_id);
    if (!principle) continue;
    try {
      await postOneComment({
        workspace,
        repoSlug,
        prId,
        violation: v,
        principle,
        token
      });
      posted += 1;
    } catch (error) {
      failures.push({ violation: v, error: String(error?.message || error) });
    }
  }
  return { posted, failures };
}

export { postReviewComments, bbAvailable };
