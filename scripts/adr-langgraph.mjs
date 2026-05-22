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
    [--model <langchain-model-string>] [--thread-id <id>] [--plan-approval] [flags...]

Examples of --model (passed to LangChain initChatModel):
  openai:gpt-4.1-mini       (default; needs OPENAI_API_KEY + @langchain/openai)
  google-genai:gemini-2.5-flash  (needs GOOGLE_API_KEY + @langchain/google-genai)
  anthropic:claude-3-5-sonnet-latest  (needs ANTHROPIC_API_KEY + @langchain/anthropic)
  ollama:llama3.1                (needs @langchain/ollama)

The model can also be set via LANGGRAPH_LLM env var.

Tuning flags (forwarded to the kernel):
  --max-rounds <n>          inner research loop rounds per task (default 2)
  --max-sources <n>         evidence items per task (default 5)
  --max-cycles <n>          bound on planned task count (default 2)
  --max-adaptive-cycles <n> gap-filling cycles after empty knowledge map (default 1)
  --skip-critique           do not run the critique agent
  --no-enforce-critique     do not auto-downgrade high-severity critique to human review
  --skip-citation-audit     do not run the post-hoc citation verifier
  --no-enforce-citation-audit
                            do not auto-downgrade unsupported selected citations
  --skip-claim-audit        do not scan generated artifacts for uncited material claims
  --plan-approval           pause after planning so the operator can edit research-plan.json
                            (programmatic resume via resumeLangGraphDeepResearch)
  --strict-clarification    stop before research if the PRD is too thin

Required runtime:
  - one live search provider: BRAVE_SEARCH_API_KEY, SERPER_API_KEY, TAVILY_API_KEY, or SEARXNG_URL
  - the API key for the provider in --model (e.g. OPENAI_API_KEY)`;
}

function describeInterrupt(result, outDir) {
  const interrupts = Array.isArray(result?.__interrupt__)
    ? result.__interrupt__
    : result?.__interrupt__
      ? [result.__interrupt__]
      : [];
  if (interrupts.length === 0) return null;
  const interruptValues = interrupts.map((entry) => entry?.value || entry);
  return {
    paused: true,
    reason: "plan_approval_requested",
    interrupts: interruptValues,
    next_steps: [
      `Plan written to ${outDir}/research-plan.json.`,
      "Edit that file if needed, then call resumeLangGraphDeepResearch programmatically",
      "with the same compiled graph + thread-id and { action: 'approve' | 'edit' | 'abort' }.",
      "Resume from the CLI is not yet supported (the in-memory checkpointer does not survive process exit)."
    ]
  };
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
  const interruptInfo = describeInterrupt(result, flags.out);
  if (interruptInfo) {
    console.log(JSON.stringify(interruptInfo, null, 2));
    process.exit(0);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}
