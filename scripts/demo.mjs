#!/usr/bin/env node
import path from "node:path";
import { activeSearchProviders, deepResearch } from "../src/kernel.mjs";

const providers = activeSearchProviders();
if (providers.length === 0) {
  console.error(
    "Demo requires live search. Set BRAVE_SEARCH_API_KEY, SERPER_API_KEY, TAVILY_API_KEY, or SEARXNG_URL."
  );
  process.exit(1);
}

if (!process.env.ADR_OPENAI_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ADR_OPENAI_BASE_URL && !process.env.OPENAI_BASE_URL) {
  console.error(
    "Demo requires LLM synthesis. Set ADR_OPENAI_API_KEY or OPENAI_API_KEY, or an OpenAI-compatible ADR_OPENAI_BASE_URL."
  );
  process.exit(1);
}

const outDir = path.resolve(".adr-runs/demo/logistics-contract-mesh");

await deepResearch({
  inputPath: "examples/logistics-contract-mesh/product-context.md",
  flags: {
    domain: "global logistics contract analysis",
    decision: "retrieval topology",
    out: outDir,
    "max-cycles": "2",
    "max-sources": "4"
  }
});

console.log(`Demo artifacts: ${outDir}`);
