#!/usr/bin/env node
import { loadConfigIntoEnv } from "./adr-doctor.mjs";
import {
  deepResearch,
  discoverPatterns,
  generateHandoff,
  research,
  supersedeAdr
} from "../src/kernel.mjs";

// Hydrate process.env from ~/.adr/config.json before any kernel call. Keys
// set in the launching shell still win — this only fills in what's missing.
await loadConfigIntoEnv();

function parseArgs(argv) {
  const [command, ...rest] = argv;
  let inputPath = null;
  const flags = {};

  // Take the first non-flag token after the command as the positional input
  // path. This lets users invoke commands like `deep-research --discover-first
  // ...` without a positional path — the parser correctly treats `--*` as a
  // flag, not as the inputPath.
  let index = 0;
  if (rest.length > 0 && !rest[0].startsWith("--")) {
    inputPath = rest[0];
    index = 1;
  }

  for (; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) continue;

    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    if (flags[key] !== undefined) {
      flags[key] = Array.isArray(flags[key]) ? [...flags[key], next] : [flags[key], next];
    } else {
      flags[key] = next;
    }
    index += 1;
  }

  return { command, inputPath, flags };
}

function usage() {
  return `Usage:
  adr deep-research <product-context.md> --domain <domain> --decision <decision> --out <dir>
  adr deep-research --discover-first --repo <path> --domain <domain> --decision <decision> --out <dir>
  adr discover --repo <path> --decision <decision> --out <dir> [--issue-body <path-or-text>]
  adr handoff <out_dir> --option <candidate-name> [--write-evaluation-pack]
  adr resume <out_dir>
  adr supersede <previous-output-dir> --with <product-context.md> --domain <domain> --decision <decision> --out <dir>

Required runtime:
  - one live search provider: BRAVE_SEARCH_API_KEY, SERPER_API_KEY, TAVILY_API_KEY, or SEARXNG_URL
    (deep-research only; not required for discover)
  - one OpenAI-compatible LLM provider: ADR_OPENAI_API_KEY or OPENAI_API_KEY

	Example (deep-research):
	  adr deep-research examples/logistics-contract-mesh/product-context.md \\
	    --domain "global logistics contract analysis" \\
	    --decision "retrieval topology" \\
	    --out .adr-runs/logistics-contract-mesh \\
	    --max-cycles 2

	Example (discover — repo scan → draft PRD):
	  adr discover \\
	    --repo . \\
	    --decision "event bus topology" \\
	    --out .adr-runs/event-bus-discover

	Example (chained — discover then deep-research in one command):
	  adr deep-research \\
	    --discover-first \\
	    --repo . \\
	    --domain "internal-tools" \\
	    --decision "event bus topology" \\
	    --out .adr-runs/event-bus-deep

	When --discover-first is set, the inputPath argument is computed from
	discover's pdr.draft.md and does not need to be supplied. Discovered
	patterns and anti-patterns that name an architecture_family flow into
	the evidence pool as private_corpus items, and anti-patterns become
	additional axes in the comparison matrix.

	Peer products (similar/competitor research):
	  --include-peers              find 3-5 similar products and research how each handles this decision
	  --max-peers <N>              cap peer count (default 5)
	  --seed <name>                seed product to anchor peer-finding (defaults to repo name when omitted)

	  When set on 'discover', writes peers.json. When set on 'deep-research'
	  (with or without --discover-first), the deep-research planner picks up
	  peers.json automatically and adds one targeted research task per peer
	  hitting their GitHub repo + docs + engineering blog. Peer findings flow
	  into the evidence pool as regular citations.

	Decision context:
	  ADR no longer pre-classifies decisions as family vs concrete. Every run
	  maps the full option space — patterns, vendors, deployment modes — and
	  outputs a ranked option set. Missing PRD context surfaces as a non-
	  blocking decision_context_gaps_detected event and as post-run follow-
	  up questions, not as a blocking gate.

	Cost / budget flags:
	  --dry-run                     print the plan + cost estimate, do not run the expensive stages.
	                                Writes cost-estimate.json + research-plan.json and exits.

	Quality flags:
	  --no-enforce-critique          do not auto-downgrade high-severity critique
	  --no-enforce-citation-audit   do not auto-downgrade unsupported selected citations
	  --skip-claim-audit            do not scan generated artifacts for uncited material claims
	  --skip-resynthesis            do not re-synthesize after critique even if high-severity issues exist
	  --skip-relevance-filter       do not drop off-topic candidates from the promoted pool
	  --skip-decision-context       do not extract decision-context notes from the PRD`;
}

async function main() {
  const { command, inputPath, flags } = parseArgs(process.argv.slice(2));

  if (command === "deep-research") {
    await deepResearch({ inputPath, flags });
    return;
  }

  // `adr resume <out_dir> [--flag value ...]` — replay the prior run's
  // flags with --resume, which skips the expensive research stage
  // (evidence.json gets loaded from disk) and re-runs synthesis +
  // critique + audits + handoff. Reads run-config.json from the out_dir
  // to reconstruct the original flags + inputPath. Any flags passed at
  // resume time override the persisted set.
  if (command === "resume") {
    if (!inputPath) {
      console.error("Usage: adr resume <out_dir> [--flag value ...]");
      process.exitCode = 1;
      return;
    }
    const { readFile } = await import("node:fs/promises");
    const path = (await import("node:path")).default;
    const configPath = path.join(path.resolve(inputPath), "run-config.json");
    let config;
    try {
      config = JSON.parse(await readFile(configPath, "utf8"));
    } catch {
      console.error(
        `No run-config.json at ${configPath}. The prior run was either incomplete or pre-dates the resume feature. ` +
          `Re-invoke with the original flags + --resume to reuse evidence.json.`
      );
      process.exitCode = 1;
      return;
    }
    const replayFlags = { ...config.flags, ...flags, resume: true };
    await deepResearch({
      inputPath: config.input_path || null,
      flags: replayFlags
    });
    return;
  }

  if (command === "research") {
    await research({ inputPath, flags });
    return;
  }

  if (command === "discover") {
    await discoverPatterns({ inputPath, flags });
    return;
  }

  if (command === "supersede") {
    await supersedeAdr({ previousDir: inputPath, flags });
    return;
  }

  if (command === "handoff") {
    if (!inputPath) {
      console.error("Usage: adr handoff <out_dir> --option <candidate-name> [--write-evaluation-pack]");
      process.exitCode = 1;
      return;
    }
    const optionName = flags.option;
    if (!optionName || typeof optionName !== "string") {
      console.error("adr handoff requires --option <candidate-name>.");
      process.exitCode = 1;
      return;
    }
    await generateHandoff({ outDir: inputPath, optionName, flags });
    return;
  }

  console.error(usage());
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
