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
        decision_kind: {
          type: "string",
          enum: ["family", "concrete"],
          description:
            "Optional override for the decision kind. \"family\" = picking an architecture pattern/topology (e.g. 'retrieval topology'). \"concrete\" = picking a specific product/vendor/library/service (e.g. 'auth provider', 'queue library'). When omitted, ADR infers from the decision name. Concrete mode adds vendor-grade axes (pricing, lock-in, SDK quality, on-prem, ecosystem) to the comparison matrix and tells the synthesizer to commit to a specific product rather than a pattern."
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
        clarification_answers: {
          type: "string",
          description:
            "Free-text answers to the clarification questions ADR raised on a prior call. Pass when re-invoking after a needs_clarification response so the run can proceed. The answers are appended to the PRD before strategic-context extraction, so latency / scale / compliance signals feed the comparison matrix."
        },
        no_clarify: {
          type: "boolean",
          description:
            "Skip the clarification gate entirely and accept a lower-confidence run. Use only when the caller has already decided that the current PRD context is enough — clarification is blocking by default in the new flow."
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
  }
];

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } }
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
  if (args.decision_kind) flags["decision-kind"] = args.decision_kind;
  if (args.clarification_answers) flags["clarification-answers"] = args.clarification_answers;
  if (args.no_clarify) flags["no-clarify"] = true;
  if (args.include_peers) flags["include-peers"] = true;
  if (typeof args.max_peers === "number") flags["max-peers"] = String(args.max_peers);
  if (args.seed) flags.seed = args.seed;

  const drResult = await deepResearch({ inputPath: args.input_path || null, flags });

  // Clarification gate blocked the run — surface the questions so the host
  // can prompt the user and re-invoke with `clarification_answers`.
  if (drResult && drResult.status === "needs_clarification") {
    return textResult({
      status: "needs_clarification",
      out_dir: drResult.out_dir,
      questions: drResult.questions,
      next_step:
        "Answer these questions and re-invoke adr_deep_research with `clarification_answers` set to the answers as text. Set `no_clarify: true` to force the run with the current PRD context instead."
    });
  }

  // Read back the handoff so the caller sees the result without a second tool
  // call. Some hosts (Claude Code) display the response inline and this gives
  // them something meaningful to surface.
  const outDir = path.resolve(args.out_dir);
  let handoff = null;
  try {
    handoff = JSON.parse(
      await readFile(path.join(outDir, "execution-handoff.json"), "utf8")
    );
  } catch {
    // Handoff missing means the run did not reach the handoff stage (e.g.
    // critique blocked it). Caller can still inspect the run directory.
  }

  return textResult({
    out_dir: outDir,
    handoff_present: Boolean(handoff),
    handoff: handoff
      ? {
          decision_id: handoff.decision_id,
          selected_topology: handoff.architecture_spec?.selected_topology || null,
          required_invariants: handoff.required_invariants || [],
          forbidden_topologies: handoff.forbidden_topologies || [],
          critique_summary: handoff.critique_summary || null,
          citation_audit_summary: handoff.citation_audit_summary || null,
          comparison_matrix_summary: handoff.comparison_matrix_summary || null
        }
      : null,
    next_step: handoff
      ? `Read ${path.join(outDir, "ADR.md")} for the human-readable decision record, or pass ${path.join(outDir, "execution-handoff.json")} to a coding agent as the implementation contract.`
      : `Run did not reach the handoff stage. Inspect ${path.join(outDir, "state.json")} and ${path.join(outDir, "events.jsonl")} to diagnose.`
  });
}

async function handleReadHandoff(args) {
  const handoffPath = path.join(path.resolve(args.out_dir), "execution-handoff.json");
  const raw = await readFile(handoffPath, "utf8");
  return textResult(JSON.parse(raw));
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name;
  const args = request.params?.arguments || {};

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
