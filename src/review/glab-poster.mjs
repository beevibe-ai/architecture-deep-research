// GitLab merge-request inline-comment poster. Uses `glab` CLI for auth +
// API access. Mirrors gh-poster.mjs's contract.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  findPrinciple,
  renderViolationComment
} from "./comment-renderer.mjs";

const execFileAsync = promisify(execFile);

async function glabAvailable() {
  try {
    await execFileAsync("glab", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function getMrMeta(mrNumber, { cwd } = {}) {
  // glab API call: read base/head SHAs needed for inline-position fields.
  const { stdout } = await execFileAsync(
    "glab",
    [
      "api",
      `projects/:id/merge_requests/${mrNumber}`
    ],
    { cwd, maxBuffer: 5 * 1024 * 1024 }
  );
  const data = JSON.parse(stdout);
  return {
    base_sha: data.diff_refs?.base_sha,
    head_sha: data.diff_refs?.head_sha,
    start_sha: data.diff_refs?.start_sha
  };
}

async function postOneComment({
  mrNumber,
  meta,
  violation,
  principle,
  cwd
}) {
  const body = renderViolationComment(violation, principle);
  const args = [
    "api",
    "--method",
    "POST",
    `projects/:id/merge_requests/${mrNumber}/discussions`,
    "-f",
    `body=${body}`,
    "-f",
    `position[base_sha]=${meta.base_sha}`,
    "-f",
    `position[head_sha]=${meta.head_sha}`,
    "-f",
    `position[start_sha]=${meta.start_sha}`,
    "-f",
    "position[position_type]=text",
    "-f",
    `position[new_path]=${violation.file}`,
    "-F",
    `position[new_line]=${violation.line}`
  ];
  await execFileAsync("glab", args, {
    cwd,
    maxBuffer: 5 * 1024 * 1024
  });
}

async function postReviewComments({
  mrNumber,
  violations,
  principles,
  cwd = process.cwd()
}) {
  if (!(await glabAvailable())) {
    throw new Error(
      "glab CLI not found. Install GitLab's glab (https://gitlab.com/gitlab-org/cli) and run `glab auth login` to post review comments."
    );
  }
  const meta = await getMrMeta(mrNumber, { cwd });
  if (!meta.head_sha) {
    throw new Error(
      `Could not resolve MR ${mrNumber}'s diff refs. Check that the MR is open and you have access.`
    );
  }
  let posted = 0;
  const failures = [];
  for (const v of violations) {
    const principle = findPrinciple(principles, v.principle_id);
    if (!principle) continue;
    try {
      await postOneComment({ mrNumber, meta, violation: v, principle, cwd });
      posted += 1;
    } catch (error) {
      failures.push({ violation: v, error: String(error?.message || error) });
    }
  }
  return { posted, failures };
}

export { postReviewComments, glabAvailable };
