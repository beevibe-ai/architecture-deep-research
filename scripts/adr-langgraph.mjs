#!/usr/bin/env node
import { runLangGraphDeepResearch } from "../adapters/langgraph.mjs";

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
    flags[key] = next;
    index += 1;
  }

  return { inputPath, flags };
}

function usage() {
  return `Usage:
  adr-langgraph <product-context.md> --domain <domain> --decision <decision> --out <dir>`;
}

const { inputPath, flags } = parseArgs(process.argv.slice(2));

if (!inputPath || !flags.domain || !flags.decision || !flags.out) {
  console.error(usage());
  process.exit(1);
}

const result = await runLangGraphDeepResearch({
  inputPath,
  domain: flags.domain,
  decision: flags.decision,
  outDir: flags.out,
  flags
});

console.log(JSON.stringify(result, null, 2));
