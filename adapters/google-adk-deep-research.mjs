import {
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  isFinalResponse,
  stringifyContent
} from "@google/adk";

import {
  deepResearch,
  getLlmJsonProvider,
  setLlmJsonProvider
} from "../src/kernel.mjs";

const DEFAULT_MODEL =
  process.env.ADR_ADK_MODEL || process.env.ADR_MODEL || "gemini-2.5-flash";

function gatedKeyMissing() {
  return (
    !process.env.GOOGLE_GENAI_API_KEY &&
    !process.env.GEMINI_API_KEY &&
    !process.env.GOOGLE_API_KEY
  );
}

function parseJsonFromText(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

async function runAgentOnce({ agent, userText }) {
  const runner = new InMemoryRunner({ agent, appName: "adr-adk" });
  let lastText = "";
  let lastFinalText = "";

  for await (const event of runner.runEphemeral({
    userId: "adr-adk",
    newMessage: { role: "user", parts: [{ text: userText }] }
  })) {
    const text = stringifyContent(event);
    if (!text) continue;
    lastText = text;
    if (isFinalResponse(event)) {
      lastFinalText = text;
    }
  }

  return lastFinalText || lastText;
}

export function createAdkJsonProvider({ model = DEFAULT_MODEL } = {}) {
  return async function adkJsonProvider({ system, user, label = "adk_json" }) {
    const agent = new LlmAgent({
      name: `adr_adk_${label.replace(/[^a-z0-9_]/gi, "_").slice(0, 40)}`,
      model,
      description: `ADR JSON-producing agent for ${label}.`,
      instruction: `${system}

Critical formatting rules:
- Respond with ONLY a single JSON object.
- Do not wrap the JSON in markdown code fences.
- Do not include any prose before or after the JSON.
- Do not include trailing commas.
- Strings must be valid JSON strings.`,
      includeContents: "none",
      generateContentConfig: {
        temperature: 0.1,
        responseMimeType: "application/json"
      },
      disallowTransferToParent: true,
      disallowTransferToPeers: true
    });

    const raw = await runAgentOnce({ agent, userText: user });
    const parsed = parseJsonFromText(raw);
    if (parsed === null) {
      throw new Error(
        `ADK provider for ${label} did not return parseable JSON. First 400 chars: ${String(
          raw
        ).slice(0, 400)}`
      );
    }
    return parsed;
  };
}

export async function runAdkDeepResearch({
  inputPath,
  domain,
  decision,
  outDir,
  flags = {},
  model = DEFAULT_MODEL
}) {
  if (!inputPath || !domain || !decision || !outDir) {
    throw new Error(
      "runAdkDeepResearch requires inputPath, domain, decision, outDir."
    );
  }
  if (gatedKeyMissing()) {
    throw new Error(
      "Google ADK deep research requires GEMINI_API_KEY or GOOGLE_GENAI_API_KEY (or GOOGLE_API_KEY) in the environment."
    );
  }

  const previousProvider = getLlmJsonProvider();
  setLlmJsonProvider(createAdkJsonProvider({ model }), {
    label: `adk-gemini:${model}`
  });

  try {
    await deepResearch({
      inputPath,
      flags: {
        ...flags,
        domain,
        decision,
        out: outDir
      }
    });
  } finally {
    setLlmJsonProvider(previousProvider || null, {
      label: previousProvider ? "restored" : "none"
    });
  }

  return {
    status: "completed",
    outDir,
    model,
    handoffBoundary: "adr_stops_at_execution_handoff"
  };
}

export function createAdkDeepResearchTool({ model = DEFAULT_MODEL } = {}) {
  return new FunctionTool({
    name: "run_adk_deep_research",
    description:
      "Run Architecture Deep Research with Google ADK / Gemini as the LLM provider, emitting ADR artifacts ending at Execution Handoff.",
    parameters: {
      type: "object",
      properties: {
        inputPath: { type: "string" },
        domain: { type: "string" },
        decision: { type: "string" },
        outDir: { type: "string" },
        flags: {
          type: "object",
          description:
            "Optional ADR runtime flags such as max-cycles, max-sources, or fetch-timeout-ms."
        }
      },
      required: ["inputPath", "domain", "decision", "outDir"]
    },
    execute: async (input) =>
      runAdkDeepResearch({
        inputPath: input.inputPath,
        domain: input.domain,
        decision: input.decision,
        outDir: input.outDir,
        flags: input.flags || {},
        model
      })
  });
}

export function createAdkDeepResearchAgent({ model = DEFAULT_MODEL } = {}) {
  return new LlmAgent({
    name: "architecture_deep_research_adk_root",
    model,
    description:
      "Root ADK agent that runs Architecture Deep Research with Gemini as the LLM provider and ends at Execution Handoff.",
    instruction:
      "You are the Architecture Deep Research Architect. Use the run_adk_deep_research tool to research a system design decision. Never implement the downstream product. Stop at Execution Handoff.",
    tools: [createAdkDeepResearchTool({ model })]
  });
}

export { DEFAULT_MODEL };
