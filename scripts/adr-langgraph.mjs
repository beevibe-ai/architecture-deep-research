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
  adr-langgraph <product-context.md> --domain <domain> --decision <decision> --out <dir> \\
    [--model <langchain-model-string>] [--thread-id <id>]

Examples of --model (passed to LangChain initChatModel):
  openai:gpt-4.1-mini       (default; needs OPENAI_API_KEY + @langchain/openai)
  google-genai:gemini-2.5-flash  (needs GOOGLE_API_KEY + @langchain/google-genai)
  anthropic:claude-3-5-sonnet-latest  (needs ANTHROPIC_API_KEY + @langchain/anthropic)
  ollama:llama3.1                (needs @langchain/ollama)

The model can also be set via LANGGRAPH_LLM env var.

Required runtime:
  - one live search provider: BRAVE_SEARCH_API_KEY, SERPER_API_KEY, TAVILY_API_KEY, or SEARXNG_URL
  - the API key for the provider in --model (e.g. OPENAI_API_KEY)`;
}

const { inputPath, flags } = parseArgs(process.argv.slice(2));

if (!inputPath || !flags.domain || !flags.decision || !flags.out) {
  console.error(usage());
  process.exit(1);
}

try {
  const result = await runLangGraphDeepResearch({
    inputPath,
    domain: flags.domain,
    decision: flags.decision,
    outDir: flags.out,
    flags,
    model: flags.model,
    threadId: flags["thread-id"]
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}
