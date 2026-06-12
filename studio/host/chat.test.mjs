// Contract test for the assistant's tool dispatch + streaming events. Only the
// Anthropic network boundary is faked — applyMutation and lint run for real, so
// this verifies that tools actually map to the right view mutations and that the
// stream emits chatToken/specPatch in order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySpec } from "../shared/ir.mjs";
import { runArchitectReview, runAssistant } from "./chat.mjs";

// A fake stream that replays scripted text + a final message with tool_use blocks.
function fakeStream({ text = "", content }) {
  const handlers = {};
  return {
    on(event, cb) {
      handlers[event] = cb;
      return this;
    },
    async finalMessage() {
      if (text && handlers.text) for (const ch of text) handlers.text(ch);
      return { content };
    },
  };
}

// A fake Anthropic client: returns scripted turns in order.
function fakeClient(turns) {
  let i = 0;
  return { messages: { stream: () => fakeStream(turns[i++]) } };
}

test("a scripted design session maps tools to the right views and streams events", async () => {
  // Turn 1: scaffold a subsystem + create an entity. Turn 2: final text, no tools.
  const turns = [
    {
      text: "Setting up billing…",
      content: [
        { type: "text", text: "Setting up billing…" },
        { type: "tool_use", id: "t1", name: "scaffold_subsystem", input: { name: "Billing", entity: "Invoice" } },
        { type: "tool_use", id: "t2", name: "flow_create_flow", input: { name: "Charge", steps: [{ type: "start", label: "Begin" }, { type: "end", label: "Done" }], transitions: [{ from: "Begin", to: "Done" }] } },
      ],
    },
    { text: "Done — added a Billing service, Invoice entity, and a Charge flow.", content: [{ type: "text", text: "Done." }] },
  ];

  const events = [];
  const result = await runAssistant({
    userText: "set up billing",
    spec: emptySpec(),
    client: fakeClient(turns),
    onEvent: (e) => events.push(e.type),
  });

  // Real reducers ran: subsystem (2 nodes + 1 edge + 1 entity + 1 cross_ref) and a flow.
  assert.equal(result.spec.views.architecture.nodes.length, 2);
  assert.equal(result.spec.views.data_model.entities.length, 1);
  assert.equal(result.spec.views.flows.length, 1);
  assert.equal(result.spec.views.flows[0].nodes.length, 2);
  assert.equal(result.spec.cross_refs.length, 1);

  // Streaming order: tokens streamed, then specPatch per applied tool call.
  assert.ok(events.includes("chatToken"));
  assert.ok(events.includes("specPatch"));
  assert.equal(events.indexOf("chatToken") < events.lastIndexOf("specPatch"), true);

  // Trace records each tool and that it succeeded.
  assert.equal(result.trace.length, 2);
  assert.ok(result.trace.every((t) => t.result.ok));
});

test("a tool error is reported back, not thrown", async () => {
  const turns = [
    { content: [{ type: "tool_use", id: "t1", name: "arch_connect", input: { from: "ghost", to: "void" } }] },
    { content: [{ type: "text", text: "Couldn't connect those — they don't exist." }] },
  ];
  const result = await runAssistant({ userText: "connect x to y", spec: emptySpec(), client: fakeClient(turns) });
  assert.equal(result.trace[0].result.ok, false);
  assert.match(result.trace[0].result.error, /unknown endpoint/);
});

test("a model that narrates without calling tools is nudged to act", async () => {
  const turns = [
    { content: [{ type: "text", text: "Let me add these components for you:" }] }, // narration, no tools
    { content: [{ type: "tool_use", id: "t1", name: "arch_add_node", input: { type: "service", label: "API" } }] }, // after the nudge
    { content: [{ type: "text", text: "Added the API service." }] },
  ];
  const result = await runAssistant({ userText: "add an api", spec: emptySpec(), client: fakeClient(turns) });
  assert.equal(result.spec.views.architecture.nodes.length, 1, "the nudge made the model actually add the node");
  assert.equal(result.trace.length, 1);
});

test("edit turn limit preserves progress and gives a continuation path", async () => {
  const turns = [
    { content: [{ type: "tool_use", id: "t1", name: "arch_add_node", input: { type: "service", label: "API" } }] },
  ];
  const result = await runAssistant({ userText: "add a larger design", spec: emptySpec(), client: fakeClient(turns), maxTurns: 1 });
  assert.equal(result.spec.views.architecture.nodes.length, 1);
  assert.equal(result.limited, true);
  assert.match(result.text, /saved that progress/);
  assert.match(result.text, /continue/);
  assert.doesNotMatch(result.text, /Reached the edit limit/);
});

test("no api key and no client returns a helpful message, not a crash", async () => {
  const result = await runAssistant({ userText: "hi", spec: emptySpec() });
  assert.match(result.text, /No Anthropic API key/);
});

test("architect review discusses without mutating or emitting spec patches", async () => {
  const turns = [
    { text: "Read\nThe API crosses into control-plane work.\n\nRecommendation\nDiscuss the boundary before changing it.", content: [{ type: "text", text: "Read\nThe API crosses into control-plane work.\n\nRecommendation\nDiscuss the boundary before changing it." }] },
  ];
  const events = [];
  const result = await runArchitectReview({
    userText: "should we separate control and execution?",
    spec: emptySpec(),
    client: fakeClient(turns),
    onEvent: (e) => events.push(e.type),
  });
  assert.match(result.text, /Recommendation/);
  assert.ok(events.includes("chatToken"));
  assert.equal(events.includes("specPatch"), false);
});
