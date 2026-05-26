#!/usr/bin/env node
// ADR MCP server.
//
// Exposes the kernel's `discover` and `deep-research` entry points as MCP
// tools over stdio. Any MCP-aware host (Claude Code, Cursor, Codex, a
// Beevibe specialist) can call them with a single tool invocation.
//
// Register with Claude Code via .claude/mcp.json:
//   { "mcpServers": { "adr": { "command": "adr-mcp" } } }
//
// Or, for a local checkout:
//   { "mcpServers": { "adr": { "command": "node",
//       "args": ["/abs/path/to/architecture-deep-research/scripts/adr-mcp.mjs"] } } }

import path from "node:path";
import { readFile } from "node:fs/promises";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfigIntoEnv } from "./adr-doctor.mjs";
import {
  deepResearch,
  discoverPatterns,
  discoverPrinciples,
  reviewDiff,
  VERSION
} from "../src/kernel.mjs";

// First thing the server does on boot: hydrate process.env from
// ~/.adr/config.json so the user does not need to remember to export keys
// in the shell that launches Claude Code. Process env wins, then file —
// matching conventional Unix override semantics.
await loadConfigIntoEnv();

const SERVER_NAME = "adr";
const SERVER_VERSION = VERSION;

const tools = [
  {
    name: "adr_discover",
    description:
      "Scan a local repo for patterns and anti-patterns the team already follows or has explicitly rejected, then draft a PRD the deep-research stage can consume. Runs locally — no web search needed. Produces discovered-principles.json, discovered-constraints.json, and pdr.draft.md in out_dir.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: {
          type: "string",
          description:
            "Absolute or relative path to the local repo to scan. Defaults to the MCP server's cwd if omitted."
        },
        decision: {
          type: "string",
          description:
            "Short name for the architecture decision being made (e.g. 'event bus topology', 'retrieval architecture')."
        },
        out_dir: {
          type: "string",
          description:
            "Where to write the three discover artifacts. Will be created if missing."
        },
        issue_body: {
          type: "string",
          description:
            "Optional. Literal GitHub issue body (or a path to a file) to seed the draft PRD. Useful when a bot is responding to an /adr comment on an issue."
        },
        include_peers: {
          type: "boolean",
          description:
            "Optional. When true, the discover stage names 3-5 similar/competitor products and writes peers.json. If you then call adr_deep_research with the same out_dir, deep-research auto-detects peers.json and adds one targeted research task per peer for the specific decision aspect."
        },
        max_peers: {
          type: "integer",
          description: "Optional. Cap the number of peer products to find. Default 5."
        },
        seed: {
          type: "string",
          description:
            "Optional. Seed product to anchor peer-finding (e.g., the user's own product name). When omitted, the finder infers from the PRD."
        }
      },
      required: ["decision", "out_dir"]
    }
  },
  {
    name: "adr_deep_research",
    description:
      "Run a full Architecture Deep Research pipeline: strategic context, research plan, live source acquisition, knowledge map with promotion gate, comparison matrix with adversarial cycles, synthesis, critique, citation audit, claim audit, evaluation pack, execution handoff. Requires a live search provider key and an LLM provider key. Set discover_first=true to chain `adr discover` before deep-research (in which case input_path is computed from discover's pdr.draft.md and does not need to be supplied).",
    inputSchema: {
      type: "object",
      properties: {
        input_path: {
          type: "string",
          description:
            "Path to the product-context markdown file. Optional when discover_first is true."
        },
        repo_path: {
          type: "string",
          description: "Repo to scan when discover_first is true. Defaults to '.'."
        },
        domain: {
          type: "string",
          description: "Domain label for the decision (e.g. 'global logistics contract analysis')."
        },
        decision: {
          type: "string",
          description: "Short name for the architecture decision being made."
        },
        out_dir: {
          type: "string",
          description: "Output directory for all run artifacts."
        },
        discover_first: {
          type: "boolean",
          description:
            "When true, run `adr discover` against repo_path first, then chain the deep-research pipeline against the resulting pdr.draft.md. Discovered architecture_family-tagged items flow into the evidence pool as private_corpus claims; anti-patterns become matrix axes."
        },
        max_cycles: {
          type: "integer",
          description: "Maximum planner cycles (default 2). The planner can dispatch up to max_cycles * 3 parallel tasks."
        },
        max_sources: {
          type: "integer",
          description: "Maximum evidence items per research task (default 5)."
        },
        issue_body: {
          type: "string",
          description: "Optional issue body to seed the discover stage when discover_first=true."
        },
        include_peers: {
          type: "boolean",
          description:
            "Optional. When true + discover_first=true, the discover stage finds 3-5 similar/competitor products and writes peers.json. Deep-research then adds one targeted research task per peer. When passed without discover_first, the planner still picks up an existing peers.json from out_dir."
        },
        max_peers: {
          type: "integer",
          description: "Optional. Cap the number of peer products to find. Default 5."
        },
        seed: {
          type: "string",
          description:
            "Optional. Seed product to anchor peer-finding (e.g., the user's own product name). When omitted, inferred from the PRD."
        }
      },
      required: ["domain", "decision", "out_dir"]
    }
  },
  {
    name: "adr_read_handoff",
    description:
      "Convenience reader: load execution-handoff.json from an ADR run directory and return it parsed. Useful for showing the user a decision summary after a deep-research run completes.",
    inputSchema: {
      type: "object",
      properties: {
        out_dir: {
          type: "string",
          description: "The run directory written by adr_deep_research."
        }
      },
      required: ["out_dir"]
    }
  },
  {
    name: "adr_principles",
    description:
      "Scan a local repo and discover the team's code-review principles: lenses (state-boundaries, llm-call-discipline, etc.), positive patterns, antipatterns, and ambiguities. Returns the principles JSON the slash command should walk the user through to confirm. Caller is responsible for the interactive interview — pass non_interactive: true here and conduct the interview in chat.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: {
          type: "string",
          description:
            "Absolute or relative path to the local repo to scan. Defaults to the MCP server's cwd."
        },
        out_dir: {
          type: "string",
          description:
            "Where to write principles.{md,json} and events.jsonl. Defaults to <repo_path>/.adr."
        },
        non_interactive: {
          type: "boolean",
          description:
            "When true (recommended for MCP), skips the readline-driven interview. Slash commands should handle the interview conversationally in chat."
        }
      },
      required: []
    }
  },
  {
    name: "adr_review",
    description:
      "Detect violations of team principles in a diff. Reads .adr/principles.json from the repo, loads the diff (from a PR#, a file, the staged area, or a branch comparison), and returns structured violations the slash command can walk the user through. By default does NOT post — the slash command should walk the user through accept/edit/skip in chat, then post via gh CLI from its own tool use.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: {
          type: "string",
          description: "Path to the repo. Defaults to MCP server cwd."
        },
        pr_number: {
          type: "integer",
          description:
            "When set, fetch the diff via `gh pr diff <N>` and review it. Requires gh CLI + authentication."
        },
        diff_path: {
          type: "string",
          description:
            "Path to a unified diff file. Use this for arbitrary diffs (e.g., feature branches without an open PR)."
        },
        staged: {
          type: "boolean",
          description:
            "When true, review `git diff --staged` (the pre-commit diff)."
        },
        branch: {
          type: "string",
          description:
            "When set, review `git diff <branch>...HEAD`. Defaults to comparing against 'main' when truthy."
        },
        top_n: {
          type: "integer",
          description:
            "Cap the number of violations returned (ranked high → medium → low). Defaults to all."
        },
        principles_path: {
          type: "string",
          description:
            "Override the principles.json location. Defaults to <repo_path>/.adr/principles.json."
        }
      },
      required: []
    }
  }
];

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  // logging capability lets us push notifications/message during long
  // tool calls so the client can show what's happening mid-call instead
  // of just a spinner.
  { capabilities: { tools: {}, logging: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

function textResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function errorResult(message, error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${message}: ${error?.message || String(error)}`
      }
    ]
  };
}

async function handleDiscover(args) {
  const flags = {
    repo: args.repo_path || ".",
    decision: args.decision,
    out: args.out_dir
  };
  if (args.issue_body) flags["issue-body"] = args.issue_body;
  if (args.include_peers) flags["include-peers"] = true;
  if (typeof args.max_peers === "number") flags["max-peers"] = String(args.max_peers);
  if (args.seed) flags.seed = args.seed;

  const result = await discoverPatterns({ flags });
  return textResult({
    out_dir: result.outDir,
    repo_path: result.repoPath,
    pattern_count: result.principles.patterns.length,
    antipattern_count: result.principles.antipatterns.length,
    peer_count: result.peerCount || 0,
    pdr_draft_path: result.draftPath,
    handoff_boundary: result.handoffBoundary,
    next_step: `Review ${result.draftPath} (especially the "Open questions" section), then call adr_deep_research with input_path set to that path, or call adr_deep_research again with discover_first: true.${result.peerCount ? ` peers.json contains ${result.peerCount} peer products that deep-research will research per-peer.` : ""}`
  });
}

async function handleDeepResearch(args) {
  const flags = {
    domain: args.domain,
    decision: args.decision,
    out: args.out_dir
  };
  if (args.repo_path) flags.repo = args.repo_path;
  if (args.discover_first) flags["discover-first"] = true;
  if (args.issue_body) flags["issue-body"] = args.issue_body;
  if (typeof args.max_cycles === "number") flags["max-cycles"] = String(args.max_cycles);
  if (typeof args.max_sources === "number") flags["max-sources"] = String(args.max_sources);
  if (args.include_peers) flags["include-peers"] = true;
  if (typeof args.max_peers === "number") flags["max-peers"] = String(args.max_peers);
  if (args.seed) flags.seed = args.seed;

  const drResult = await deepResearch({ inputPath: args.input_path || null, flags });

  // Read back the research report so the caller sees the result without a
  // second tool call. The default pipeline does NOT produce execution-handoff.json
  // anymore — that's lazy (run `adr handoff <out_dir> --option <name>`).
  const outDir = path.resolve(args.out_dir);
  let report = null;
  try {
    report = JSON.parse(
      await readFile(path.join(outDir, "research-report.json"), "utf8")
    );
  } catch {
    // Report missing means the run did not reach the artifact stage. Caller
    // can still inspect the run directory.
  }

  return textResult({
    out_dir: outDir,
    report_present: Boolean(report),
    report: report
      ? {
          decision_id: report.id,
          title: report.title,
          candidates: (report.options || []).map((o) => ({
            name: o.name,
            label: o.label,
            evidence_depth: o.evidence_depth || "thin"
          })),
          executive_summary: String(report.executive_summary || "").slice(0, 500),
          open_questions: report.open_questions || []
        }
      : null,
    next_step: report
      ? `Read ${path.join(outDir, "ADR.md")} for the human-readable report. Pick a candidate, then run \`adr handoff ${outDir} --option <name>\` to generate the implementation contract.`
      : `Run did not reach the artifact stage. Inspect ${path.join(outDir, "state.json")} and ${path.join(outDir, "events.jsonl")} to diagnose.`
  });
}

async function handleReadHandoff(args) {
  const handoffPath = path.join(path.resolve(args.out_dir), "execution-handoff.json");
  const raw = await readFile(handoffPath, "utf8");
  return textResult(JSON.parse(raw));
}

// Build an onProgress callback that forwards each principles-pipeline
// step to the MCP client as both a logging message AND (when the request
// supplied a progressToken) a structured progress notification. Different
// MCP clients surface different notification types — sending both is
// cheap and maximizes the chance the user sees live progress in the
// chat UI instead of staring at a spinner.
function buildMcpProgressCallback(progressToken) {
  let counter = 0;
  return ({ label, detail }) => {
    counter += 1;
    const message = detail ? `${label} — ${detail}` : label;
    // logging notification — universally surfaced
    server
      .sendLoggingMessage({ level: "info", data: message, logger: "adr_principles" })
      .catch(() => {});
    // progress notification — used by clients that opted in via
    // _meta.progressToken. Send only when token is present; otherwise
    // it's a no-op.
    if (progressToken !== undefined && progressToken !== null) {
      server
        .notification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: counter,
            message
          }
        })
        .catch(() => {});
    }
  };
}

async function handlePrinciples(args, extra) {
  const flags = {
    repo: args.repo_path || ".",
    "non-interactive":
      args.non_interactive === false ? false : true
  };
  if (args.out_dir) flags.out = args.out_dir;
  const progressToken = extra?._meta?.progressToken ?? extra?.requestId;
  const onProgress = buildMcpProgressCallback(progressToken);
  const result = await discoverPrinciples({ flags, onProgress });
  return textResult({
    out_dir: result.outDir,
    repo_path: result.repoPath,
    lens_count: result.lenses.length,
    lenses: result.lenses.map((l) => ({
      slug: l.slug,
      name: l.name,
      rationale: l.rationale
    })),
    principle_count: result.principles.length,
    principles: result.principles.map((p) => ({
      id: p.id,
      lens: p.lens,
      polarity: p.polarity,
      rule: p.rule,
      rationale: p.rationale,
      evidence_cite: p.evidence_cite,
      examples_to_follow: p.examples_to_follow,
      confidence: p.confidence,
      confirmed_by_interview: p.confirmed_by_interview
    })),
    md_path: result.mdPath,
    json_path: result.jsonPath,
    interview_skipped: flags["non-interactive"] === true,
    next_step: flags["non-interactive"]
      ? "The interactive interview was skipped (MCP mode). Walk the user through the ambiguities in chat, then re-run with confirmed answers, or accept the principles as-is and run adr_review against a PR."
      : "Principles are confirmed and ready. Run adr_review against a PR to check it."
  });
}

async function handleReview(args) {
  const flags = {
    repo: args.repo_path || ".",
    "non-interactive": true  // MCP is non-interactive; chat handles UX
  };
  let inputPath = null;
  if (typeof args.pr_number === "number") {
    inputPath = String(args.pr_number);
  } else if (args.diff_path) {
    flags.diff = args.diff_path;
  } else if (args.staged === true) {
    flags.staged = true;
  } else if (args.branch) {
    flags.branch = args.branch;
  } else {
    throw new Error(
      "adr_review needs one of: pr_number, diff_path, staged: true, or branch."
    );
  }
  if (typeof args.top_n === "number") flags["top-n"] = String(args.top_n);
  if (args.principles_path) flags.principles = args.principles_path;

  const result = await reviewDiff({ inputPath, flags });

  // Read the principles back so the slash command can render comments
  // without a second MCP call.
  const principlesPath = path.resolve(
    args.principles_path ||
      path.join(args.repo_path || ".", ".adr", "principles.json")
  );
  let principlesArtifact = null;
  try {
    principlesArtifact = JSON.parse(await readFile(principlesPath, "utf8"));
  } catch {
    // already validated by reviewDiff; ignore
  }

  return textResult({
    out_dir: result.outDir,
    artifact_path: result.artifactPath,
    files_reviewed: result.filesReviewed,
    violation_count: result.violations.length,
    violations: result.violations,
    principles: principlesArtifact
      ? principlesArtifact.principles.map((p) => ({
          id: p.id,
          lens: p.lens,
          polarity: p.polarity,
          rule: p.rule,
          rationale: p.rationale,
          examples_to_follow: p.examples_to_follow
        }))
      : [],
    next_step:
      result.violations.length === 0
        ? "No principle violations found. Ship it."
        : `Walk the user through these ${result.violations.length} violations one at a time. For each, show: principle.rule, the violation message, file:line, and the team example to follow. Accept/edit/skip per the user's input. For accepted ones, post via gh CLI: \`gh api repos/<owner>/<repo>/pulls/<N>/comments --method POST -f body=<rendered> -f commit_id=<sha> -f path=<file> -F line=<line> -f side=RIGHT\`.`
  });
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const name = request.params?.name;
  const args = request.params?.arguments || {};
  // Forward the request's _meta (carries progressToken) so handlers can
  // emit live notifications during long-running tool calls.
  const handlerExtra = {
    _meta: request.params?._meta || {},
    requestId: extra?.requestId
  };

  // Re-read ~/.adr/config.json on every tool call. The user may have run
  // `adr-doctor set ...` since the server booted (e.g. through the /adr:doctor
  // slash command), and we want the new keys to take effect on the next call
  // without requiring a Claude Code restart. Process env from the launching
  // shell always wins — see loadConfigIntoEnv() in adr-doctor.mjs.
  await loadConfigIntoEnv();

  try {
    if (name === "adr_discover") return await handleDiscover(args);
    if (name === "adr_deep_research") return await handleDeepResearch(args);
    if (name === "adr_read_handoff") return await handleReadHandoff(args);
    if (name === "adr_principles") return await handlePrinciples(args, handlerExtra);
    if (name === "adr_review") return await handleReview(args);
    return errorResult(
      "unknown_tool",
      new Error(
        `Tool '${name}' is not registered. Available: ${tools.map((t) => t.name).join(", ")}.`
      )
    );
  } catch (error) {
    return errorResult(`${name} failed`, error);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
