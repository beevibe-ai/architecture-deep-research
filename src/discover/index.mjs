import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  activeLlmProvider,
  appendEvent,
  nowIso,
  resetLlmCost,
  VERSION,
  writeJson
} from "../kernel.mjs";
import { scanRepo } from "./repo-scan.mjs";
import { extractPrinciples } from "./principle-extractor.mjs";
import { extractConstraints } from "./constraint-extractor.mjs";
import { draftPrd } from "./prd-drafter.mjs";
import { findPeers, DEFAULT_MAX_PEERS } from "./peer-finder.mjs";

function assertDiscoverRuntime() {
  // discover does not need a web-search provider — it only reads the local
  // repo. It still needs an LLM provider for the three extractor stages.
  const llm = activeLlmProvider();
  if (!llm) {
    throw new Error(
      "No LLM synthesis provider configured. Set ADR_OPENAI_API_KEY or OPENAI_API_KEY for the OpenAI-compatible runtime before running adr discover. Alternatively, install a custom provider via setLlmJsonProvider() (used by the test/smoke fixtures)."
    );
  }
  return { llmProvider: llm };
}

async function readIssueBody(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    value = value[value.length - 1];
  }
  // Two modes: a path to a file, or a literal string (when the bot pastes the
  // issue body directly). We try file-first; on ENOENT we treat it as literal.
  try {
    const resolved = path.resolve(String(value));
    return await readFile(resolved, "utf8");
  } catch {
    return String(value);
  }
}

async function discoverPatterns({ inputPath, flags = {}, chained = false } = {}) {
  const repoPath = path.resolve(flags.repo || inputPath || ".");
  const decision = flags.decision || null;
  if (!flags.out) {
    throw new Error(
      "Usage: adr discover --repo <path> --decision <decision> --out <dir> [--issue-body <path|text>]"
    );
  }
  if (!decision) {
    throw new Error(
      "adr discover requires --decision <decision>. Example: --decision \"event bus topology\"."
    );
  }

  const runtime = assertDiscoverRuntime();
  const outDir = path.resolve(flags.out);
  await mkdir(outDir, { recursive: true });
  if (!chained) {
    // Fresh standalone discover run — truncate events.jsonl and reset cost.
    // When chained from `adr deep-research --discover-first`, the caller has
    // already initialized both and wants discover's events on the same log.
    await writeFile(path.join(outDir, "events.jsonl"), "");
    resetLlmCost();
  }

  const issueBody = await readIssueBody(flags["issue-body"]);
  const startedAt = nowIso();

  await appendEvent(outDir, "discover_started", {
    runtime,
    repo_path: repoPath,
    decision,
    issue_body_present: Boolean(issueBody)
  });

  // STEP 1 — deterministic scan (no LLM)
  const scan = await scanRepo(repoPath);
  await appendEvent(outDir, "repo_scanned", { ...scan.summary });

  // STEP 2 — LLM: patterns + anti-patterns
  const principles = await extractPrinciples(scan, { decision, issueBody });
  const principlesArtifact = {
    version: VERSION,
    source: {
      repo_path: scan.repo_path,
      scanned_at: startedAt,
      decision,
      issue_body_present: Boolean(issueBody)
    },
    patterns: principles.patterns,
    antipatterns: principles.antipatterns,
    scan_summary: {
      file_count: scan.summary.file_count,
      manifest_count: scan.summary.manifest_count,
      deploy_configs: scan.deploy_configs.map((c) => c.platform),
      prior_adr_count: scan.summary.prior_adr_count,
      todo_count: scan.summary.todo_hit_count
    }
  };
  await writeJson(path.join(outDir, "discovered-principles.json"), principlesArtifact);
  await appendEvent(outDir, "principles_extracted", {
    pattern_count: principles.patterns.length,
    antipattern_count: principles.antipatterns.length
  });

  // STEP 3 — LLM: stack + deploy + compliance
  const constraints = await extractConstraints(scan, { decision });
  const constraintsArtifact = {
    version: VERSION,
    source: {
      repo_path: scan.repo_path,
      scanned_at: startedAt,
      decision
    },
    ...constraints
  };
  await writeJson(path.join(outDir, "discovered-constraints.json"), constraintsArtifact);
  await appendEvent(outDir, "constraints_extracted", {
    stack_count: constraints.stack.length,
    compliance_count: constraints.compliance_signals.length,
    deploy_target: constraints.deploy_target.platform
  });

  // STEP 4 — LLM: PRD draft
  const markdown = await draftPrd({
    decision,
    principles,
    constraints,
    issueBody,
    repoPath: scan.repo_path
  });
  const draftPath = path.join(outDir, "pdr.draft.md");
  await writeFile(draftPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  await appendEvent(outDir, "pdr_drafted", {
    draft_path: draftPath,
    bytes: Buffer.byteLength(markdown, "utf8")
  });

  // STEP 5 (optional) — find similar / peer products and write peers.json.
  // Opt-in via --include-peers because the LLM call costs a few cents and
  // the GitHub signal fetch can take a few seconds per peer. When set,
  // deep-research will automatically detect peers.json in outDir and add
  // one targeted research task per peer for the specific decision aspect.
  let peerCount = 0;
  if (flags["include-peers"]) {
    const maxPeers = Number(flags["max-peers"] || DEFAULT_MAX_PEERS);
    try {
      const peersArtifact = await findPeers({
        decision,
        domain: flags.domain || "(unspecified)",
        decisionKind: flags["decision-kind"],
        seed: flags.seed || flags["peer-seed"] || null,
        prd: markdown,
        issueBody,
        repoDigest: scan,
        flags,
        maxPeers
      });
      await writeJson(path.join(outDir, "peers.json"), peersArtifact);
      peerCount = peersArtifact.peers.length;
      await appendEvent(outDir, "peers_found", {
        peer_count: peerCount,
        // Concrete content: each peer with the WHY — "Cal.com - multi-
        // tenant SaaS shipping its own auth + scheduling" — and momentum
        // signal so the user can see why this peer was picked.
        peers: peersArtifact.peers.map((p) => ({
          name: p.name,
          label: p.label,
          github_url: p.github_url || null,
          stars: p.signal?.stars || null,
          last_commit_at: p.signal?.last_commit_at || null,
          why_comparable: p.why_comparable || ""
        }))
      });
    } catch (error) {
      await appendEvent(outDir, "peers_extraction_failed", {
        error: String(error?.message || error)
      });
    }
  }

  await appendEvent(outDir, "discover_completed", {
    pattern_count: principles.patterns.length,
    antipattern_count: principles.antipatterns.length,
    draft_path: draftPath,
    peer_count: peerCount
  });

  return {
    outDir,
    repoPath: scan.repo_path,
    principles,
    constraints,
    draftPath,
    peerCount,
    handoffBoundary: "discover_stops_at_pdr_draft"
  };
}

export { discoverPatterns };
