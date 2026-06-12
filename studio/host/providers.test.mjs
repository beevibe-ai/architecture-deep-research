import test from "node:test";
import assert from "node:assert/strict";
import { defaultModel, makeProvider, providerDefinitions, providerEnvNames, providerLabel } from "./providers.mjs";

function chunks(items) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

test("provider registry exposes fallback-friendly hosted providers", () => {
  const ids = providerDefinitions().map((p) => p.id);
  assert.deepEqual(ids, ["anthropic", "openai", "openrouter", "groq", "together", "deepseek", "openai-compatible"]);
  assert.equal(providerLabel("openrouter"), "OpenRouter");
  assert.equal(defaultModel("openrouter"), "openrouter/auto");
  assert.ok(providerEnvNames("groq").includes("GROQ_API_KEY"));
  assert.equal(defaultModel("deepseek"), "deepseek-v4-flash");
  assert.ok(providerEnvNames("deepseek").includes("DEEPSEEK_API_KEY"));
});

test("OpenAI-compatible providers normalize streaming text and tool calls", async () => {
  let captured;
  const client = {
    chat: {
      completions: {
        create: async (req) => {
          captured = req;
          return chunks([
            { choices: [{ delta: { content: "Adding " } }] },
            { choices: [{ delta: { content: "API" } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "arch_add_node", arguments: "{\"type\":\"service\"," } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"label\":\"API\"}" } }] } }] },
          ]);
        },
      },
    },
  };
  const seen = [];
  const provider = makeProvider("openrouter", { apiKey: "test", client });
  const result = await provider.stream({
    system: "sys",
    model: "openrouter/auto",
    maxTokens: 100,
    history: [{ role: "user", text: "add api" }],
    tools: [{ name: "arch_add_node", description: "add", input_schema: { type: "object" } }],
    onText: (t) => seen.push(t),
  });

  assert.equal(captured.model, "openrouter/auto");
  assert.equal(captured.messages[0].role, "system");
  assert.equal(captured.tools[0].function.name, "arch_add_node");
  assert.deepEqual(seen, ["Adding ", "API"]);
  assert.deepEqual(result.blocks, [
    { type: "text", text: "Adding API" },
    { type: "tool_use", id: "call_1", name: "arch_add_node", input: { type: "service", label: "API" } },
  ]);
});
