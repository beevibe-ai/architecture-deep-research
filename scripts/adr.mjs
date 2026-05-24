#!/usr/bin/env node
import { loadConfigIntoEnv } from "./adr-doctor.mjs";
import { deepResearch, discoverPatterns, research, supersedeAdr } from "../src/kernel.mjs";

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

	Quality flags:
	  --no-enforce-critique          do not auto-downgrade high-severity critique
	  --no-enforce-citation-audit   do not auto-downgrade unsupported selected citations
	  --skip-claim-audit            do not scan generated artifacts for uncited material claims`;
}

async function main() {
  const { command, inputPath, flags } = parseArgs(process.argv.slice(2));

  if (command === "deep-research") {
    await deepResearch({ inputPath, flags });
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

  console.error(usage());
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
