#!/usr/bin/env node
import { runAdkDeepResearch } from "../adapters/google-adk-deep-research.mjs";

function parseArgs(argv) {
  const [inputPath, ...rest] = argv;
  const flags = {};

  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    if (flags[key] !== undefined) {
      flags[key] = Array.isArray(flags[key])
        ? [...flags[key], next]
        : [flags[key], next];
    } else {
      flags[key] = next;
    }
    index += 1;
  }

  return { inputPath, flags };
}

function usage() {
  return `Usage:
  adr-adk <product-context.md> --domain <domain> --decision <decision> --out <dir> [--model <model>]

Required env:
  GEMINI_API_KEY or GOOGLE_GENAI_API_KEY (or GOOGLE_API_KEY)
  one live search provider: BRAVE_SEARCH_API_KEY, SERPER_API_KEY, TAVILY_API_KEY, or SEARXNG_URL

Optional env:
  ADR_ADK_MODEL (default: gemini-2.5-flash)

Example:
  npm run adr:adk -- examples/logistics-contract-mesh/product-context.md \\
    --domain "global logistics contract analysis" \\
    --decision "retrieval topology" \\
    --out .adr-runs/adk-logistics-contract-mesh \\
    --max-cycles 2`;
}

const { inputPath, flags } = parseArgs(process.argv.slice(2));

if (!inputPath || !flags.domain || !flags.decision || !flags.out) {
  console.error(usage());
  process.exit(1);
}

try {
  const result = await runAdkDeepResearch({
    inputPath,
    domain: flags.domain,
    decision: flags.decision,
    outDir: flags.out,
    flags,
    model: flags.model
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}
