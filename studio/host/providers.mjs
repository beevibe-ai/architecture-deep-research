// LLM provider abstraction. The assistant's agentic loop (tool-call → applyMutation
// → lint → repeat) is identical across providers; only the wire format differs.
// Each adapter exposes one method: stream(), which takes a normalized history and
// returns a normalized assistant turn:
//
//   history entry = { role:"user", text }
//                 | { role:"assistant", blocks: [...] }
//                 | { role:"tool", results: [{ tool_use_id, content }] }
//   block         = { type:"text", text } | { type:"tool_use", id, name, input }
//
// So chat.mjs never sees Anthropic vs OpenAI shapes.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const PROVIDERS = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    defaultModel: "claude-sonnet-4-6",
    modelSetting: "model",
    env: ["ANTHROPIC_API_KEY", "ADR_ANTHROPIC_API_KEY"],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    kind: "openai-compatible",
    defaultModel: "gpt-4o",
    modelSetting: "openaiModel",
    env: ["OPENAI_API_KEY", "ADR_OPENAI_API_KEY"],
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-compatible",
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/auto",
    modelSetting: "openrouterModel",
    env: ["OPENROUTER_API_KEY", "ADR_OPENROUTER_API_KEY"],
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/beevibe-ai/architecture-deep-research",
      "X-OpenRouter-Title": "ADR Studio",
    },
  },
  groq: {
    id: "groq",
    label: "Groq",
    kind: "openai-compatible",
    baseURL: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    modelSetting: "groqModel",
    env: ["GROQ_API_KEY", "ADR_GROQ_API_KEY"],
  },
  together: {
    id: "together",
    label: "Together AI",
    kind: "openai-compatible",
    baseURL: "https://api.together.ai/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    modelSetting: "togetherModel",
    env: ["TOGETHER_API_KEY", "ADR_TOGETHER_API_KEY"],
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai-compatible",
    baseURL: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    modelSetting: "deepseekModel",
    env: ["DEEPSEEK_API_KEY", "ADR_DEEPSEEK_API_KEY"],
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "Custom OpenAI-compatible",
    kind: "openai-compatible",
    defaultModel: "gpt-4o-mini",
    modelSetting: "openaiCompatibleModel",
    baseUrlSetting: "openaiCompatibleBaseUrl",
    env: ["OPENAI_COMPATIBLE_API_KEY", "ADR_OPENAI_COMPATIBLE_API_KEY"],
  },
};

export function providerDefinitions() {
  return Object.values(PROVIDERS).map((p) => ({ ...p, defaultHeaders: p.defaultHeaders ? { ...p.defaultHeaders } : undefined }));
}

export function providerDefinition(name) {
  return PROVIDERS[name] || PROVIDERS.anthropic;
}

export function providerLabel(provider) {
  return providerDefinition(provider).label;
}

export function providerEnvNames(provider) {
  return providerDefinition(provider).env || [];
}

export function modelSetting(provider) {
  return providerDefinition(provider).modelSetting;
}

export function makeProvider(name, { apiKey, client, baseURL }) {
  const def = providerDefinition(name);
  if (def.kind === "anthropic") return anthropicProvider({ apiKey, client });
  return openaiProvider({ apiKey, client, baseURL: baseURL || def.baseURL, defaultHeaders: def.defaultHeaders });
}

export function defaultModel(provider) {
  return providerDefinition(provider).defaultModel;
}

// ---- Anthropic ----
function anthropicProvider({ apiKey, client }) {
  const c = client || new Anthropic({ apiKey });
  return {
    async stream({ system, tools = [], model, history, maxTokens, onText }) {
      const messages = history.map(toAnthropicMsg);
      const req = { model, max_tokens: maxTokens, system, messages };
      if (tools.length) req.tools = tools;
      const stream = c.messages.stream(req);
      if (stream.on) stream.on("text", (t) => onText(t));
      const msg = await stream.finalMessage();
      return { blocks: msg.content };
    },
  };
}
function toAnthropicMsg(e) {
  if (e.role === "user") return { role: "user", content: e.text };
  if (e.role === "assistant") return { role: "assistant", content: e.blocks };
  return { role: "user", content: e.results.map((r) => ({ type: "tool_result", tool_use_id: r.tool_use_id, content: r.content })) };
}

// ---- OpenAI ----
function openaiProvider({ apiKey, client, baseURL, defaultHeaders }) {
  const opts = { apiKey };
  if (baseURL) opts.baseURL = baseURL;
  if (defaultHeaders) opts.defaultHeaders = defaultHeaders;
  const c = client || new OpenAI(opts);
  const oaiTools = (tools) => tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  return {
    async stream({ system, tools = [], model, history, maxTokens, onText }) {
      const messages = [{ role: "system", content: system }, ...history.flatMap(toOpenAIMsgs)];
      const req = { model, messages, max_tokens: maxTokens, stream: true };
      if (tools.length) req.tools = oaiTools(tools);
      const stream = await c.chat.completions.create(req);
      let text = "";
      const acc = {}; // index -> { id, name, args }
      for await (const chunk of stream) {
        const d = chunk.choices?.[0]?.delta || {};
        if (d.content) { text += d.content; onText(d.content); }
        for (const tc of d.tool_calls || []) {
          const i = tc.index ?? 0;
          acc[i] = acc[i] || { id: tc.id, name: "", args: "" };
          if (tc.id) acc[i].id = tc.id;
          if (tc.function?.name) acc[i].name += tc.function.name;
          if (tc.function?.arguments) acc[i].args += tc.function.arguments;
        }
      }
      const blocks = [];
      if (text) blocks.push({ type: "text", text });
      for (const i of Object.keys(acc)) {
        const t = acc[i];
        let input = {};
        try { input = JSON.parse(t.args || "{}"); } catch { /* partial/invalid args → empty */ }
        blocks.push({ type: "tool_use", id: t.id || `call_${i}`, name: t.name, input });
      }
      return { blocks };
    },
  };
}
function toOpenAIMsgs(e) {
  if (e.role === "user") return [{ role: "user", content: e.text }];
  if (e.role === "assistant") {
    const text = e.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const toolCalls = e.blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
    const msg = { role: "assistant", content: text || null };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    return [msg];
  }
  return e.results.map((r) => ({ role: "tool", tool_call_id: r.tool_use_id, content: r.content }));
}
