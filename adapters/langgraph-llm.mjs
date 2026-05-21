import { initChatModel } from "langchain/chat_models/universal";

const DEFAULT_MODEL_STRING =
  process.env.LANGGRAPH_LLM ||
  process.env.ADR_LANGGRAPH_LLM ||
  "openai:gpt-4.1-mini";

function jsonSystemSuffix() {
  return `

Critical formatting rules:
- Respond with ONLY a single JSON object.
- Do not wrap the JSON in markdown code fences.
- Do not include any prose before or after the JSON.
- Do not include trailing commas.
- Strings must be valid JSON strings.`;
}

function parseJsonFromText(text) {
  if (text == null) return null;
  const raw =
    typeof text === "string"
      ? text
      : Array.isArray(text)
        ? text
            .map((part) => (typeof part === "string" ? part : part?.text || ""))
            .join("")
        : String(text);
  const trimmed = raw.trim();
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

export async function loadLangChainChatModel({
  model = DEFAULT_MODEL_STRING,
  temperature = 0.1
} = {}) {
  return initChatModel(model, { temperature });
}

export function createLangChainJsonProvider({
  model = DEFAULT_MODEL_STRING,
  temperature = 0.1
} = {}) {
  let cachedModel = null;
  let cachedKey = null;

  async function getModel() {
    const key = `${model}:${temperature}`;
    if (cachedModel && cachedKey === key) return cachedModel;
    cachedModel = await loadLangChainChatModel({ model, temperature });
    cachedKey = key;
    return cachedModel;
  }

  return async function langChainJsonProvider({ system, user, label = "lg_json" }) {
    const chat = await getModel();
    const response = await chat.invoke([
      { role: "system", content: `${system}${jsonSystemSuffix()}` },
      { role: "user", content: user }
    ]);
    const parsed = parseJsonFromText(response?.content);
    if (parsed === null) {
      const preview =
        typeof response?.content === "string"
          ? response.content.slice(0, 400)
          : JSON.stringify(response?.content || "").slice(0, 400);
      throw new Error(
        `LangChain provider for ${label} did not return parseable JSON. First 400 chars: ${preview}`
      );
    }
    return parsed;
  };
}

export { DEFAULT_MODEL_STRING };
