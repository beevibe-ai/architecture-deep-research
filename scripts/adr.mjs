#!/usr/bin/env node
import { deepResearch, research, supersedeAdr } from "../src/kernel.mjs";

function parseArgs(argv) {
  const [command, inputPath, ...rest] = argv;
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
  adr supersede <previous-output-dir> --with <product-context.md> --domain <domain> --decision <decision> --out <dir>

Required runtime:
  - one live search provider: BRAVE_SEARCH_API_KEY, SERPER_API_KEY, TAVILY_API_KEY, or SEARXNG_URL
  - one OpenAI-compatible LLM provider: ADR_OPENAI_API_KEY or OPENAI_API_KEY

Example:
  adr deep-research examples/logistics-contract-mesh/product-context.md \\
    --domain "global logistics contract analysis" \\
    --decision "retrieval topology" \\
    --out .adr-runs/logistics-contract-mesh \\
    --max-cycles 2`;
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
