// GitHub-only signal collector. Best-effort: if `gh` CLI is missing or
// unauthenticated, or the repo has no GitHub origin, we silently return
// empty signals — the rest of the pipeline still runs.
//
// Two streams of signal:
//
//   1. Closed issues with rejection labels (wontfix, won't fix,
//      out-of-scope, not-planned, declined). The team's actual library
//      of rejected alternatives — direct input for `non_goals`.
//
//   2. Merged PRs whose titles match architecture-keyword patterns
//      (refactor, migrate, switch, move, replace, drop, remove, adopt,
//      ditch). The PR description is usually where the team wrote the
//      rationale — input for `architectural_intent.why`.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_ISSUES = 30;
const MAX_PRS = 30;
const MAX_BODY_BYTES = 1_200;

const REJECTION_LABELS = [
  "wontfix",
  "won't fix",
  "wont-fix",
  "won't-fix",
  "out of scope",
  "out-of-scope",
  "not planned",
  "not-planned",
  "declined",
  "duplicate"
];

const ARCH_KEYWORDS = [
  "refactor",
  "migrate",
  "switch",
  "move",
  "replace",
  "drop",
  "remove",
  "adopt",
  "ditch",
  "rewrite",
  "split",
  "merge",
  "consolidate",
  "extract"
];

async function ghAvailable() {
  try {
    await execFileAsync("gh", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function detectGithubOrigin(cwd) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd, maxBuffer: 1024 * 1024 }
    );
    const url = stdout.trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!m) return null;
    return { owner: m[1], repo: m[2] };
  } catch {
    return null;
  }
}

function clipBody(body) {
  if (!body) return "";
  const s = String(body).replace(/\r/g, "");
  return s.length > MAX_BODY_BYTES ? `${s.slice(0, MAX_BODY_BYTES)}…` : s;
}

async function fetchRejectedIssues({ owner, repo, cwd }) {
  // gh issue list --state closed --label wontfix returns the labels we
  // searched on. We loop through known rejection-labels and dedupe.
  const collected = new Map();
  for (const label of REJECTION_LABELS) {
    if (collected.size >= MAX_ISSUES) break;
    try {
      const { stdout } = await execFileAsync(
        "gh",
        [
          "api",
          "--method",
          "GET",
          `repos/${owner}/${repo}/issues`,
          "-f",
          "state=closed",
          "-f",
          `labels=${label}`,
          "-F",
          "per_page=10"
        ],
        { cwd, maxBuffer: 5 * 1024 * 1024 }
      );
      const arr = JSON.parse(stdout);
      if (!Array.isArray(arr)) continue;
      for (const issue of arr) {
        if (collected.size >= MAX_ISSUES) break;
        if (issue.pull_request) continue; // exclude PRs (the issues API also returns PRs)
        if (collected.has(issue.number)) continue;
        collected.set(issue.number, {
          number: issue.number,
          title: issue.title,
          label,
          url: issue.html_url,
          body: clipBody(issue.body)
        });
      }
    } catch {
      // Some labels may not exist — keep going.
    }
  }
  return [...collected.values()];
}

async function fetchArchKeywordPrs({ owner, repo, cwd }) {
  // GitHub search API supports `is:pr is:merged` plus title filtering via
  // the `in:title` qualifier and keyword union. We do one search call
  // covering all architecture keywords.
  try {
    const keywordExpr = ARCH_KEYWORDS.map((k) => `${k} in:title`).join(" OR ");
    const query = `repo:${owner}/${repo} is:pr is:merged (${keywordExpr})`;
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        "--method",
        "GET",
        "search/issues",
        "-f",
        `q=${query}`,
        "-F",
        `per_page=${MAX_PRS}`
      ],
      { cwd, maxBuffer: 5 * 1024 * 1024 }
    );
    const data = JSON.parse(stdout);
    const items = Array.isArray(data.items) ? data.items : [];
    const prs = [];
    for (const item of items.slice(0, MAX_PRS)) {
      // The search/issues endpoint returns the issue-shape body for PRs;
      // it's adequate for the rationale we need.
      prs.push({
        number: item.number,
        title: item.title,
        url: item.html_url,
        body: clipBody(item.body)
      });
    }
    return prs;
  } catch {
    return [];
  }
}

async function extractGitHubSignals({ repoPath }) {
  const empty = {
    available: false,
    origin: null,
    rejected_issues: [],
    arch_keyword_prs: [],
    summary: {
      rejected_issue_count: 0,
      arch_keyword_pr_count: 0,
      reason: ""
    }
  };

  if (!(await ghAvailable())) {
    return { ...empty, summary: { ...empty.summary, reason: "gh_cli_missing" } };
  }
  const origin = await detectGithubOrigin(repoPath);
  if (!origin) {
    return { ...empty, summary: { ...empty.summary, reason: "not_github_repo" } };
  }

  const [issues, prs] = await Promise.all([
    fetchRejectedIssues({ ...origin, cwd: repoPath }),
    fetchArchKeywordPrs({ ...origin, cwd: repoPath })
  ]);

  return {
    available: true,
    origin,
    rejected_issues: issues,
    arch_keyword_prs: prs,
    summary: {
      rejected_issue_count: issues.length,
      arch_keyword_pr_count: prs.length,
      reason: ""
    }
  };
}

export { extractGitHubSignals };
