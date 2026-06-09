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

export function makeProvider(name, { apiKey, client }) {
  return name === "openai" ? openaiProvider({ apiKey, client }) : anthropicProvider({ apiKey, client });
}

export function defaultModel(provider) {
  return provider === "openai" ? "gpt-4o" : "claude-sonnet-4-6";
}

// ---- Anthropic ----
function anthropicProvider({ apiKey, client }) {
  const c = client || new Anthropic({ apiKey });
  return {
    async stream({ system, tools, model, history, maxTokens, onText }) {
      const messages = history.map(toAnthropicMsg);
      const stream = c.messages.stream({ model, max_tokens: maxTokens, system, tools, messages });
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
function openaiProvider({ apiKey, client }) {
  const c = client || new OpenAI({ apiKey });
  const oaiTools = (tools) => tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  return {
    async stream({ system, tools, model, history, maxTokens, onText }) {
      const messages = [{ role: "system", content: system }, ...history.flatMap(toOpenAIMsgs)];
      const stream = await c.chat.completions.create({ model, messages, tools: oaiTools(tools), max_tokens: maxTokens, stream: true });
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
