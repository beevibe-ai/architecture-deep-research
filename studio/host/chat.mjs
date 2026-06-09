// The design assistant. The model never returns free-form "here's your
// architecture" prose that someone has to re-key — it edits the IR through
// tools, the exact same applyMutation path drag-drop uses. Every edit is then
// linted, and the model sees the violations on the next turn so it can react
// ("I added the cache, but note clients still hit the DB directly").

import Anthropic from "@anthropic-ai/sdk";
import { applyMutation } from "../shared/ir.mjs";
import { lint } from "../shared/constraints.mjs";

const TOOLS = [
  {
    name: "add_node",
    description: "Add a component to the design.",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["service", "datastore", "queue", "gateway", "client", "external"],
        },
        label: { type: "string" },
        tech: { type: "string", description: "Implementation tech, e.g. Postgres, Redis." },
        context: { type: "string", description: "Bounded context this belongs to." },
        notes: { type: "string", description: "Design intent for the coding agent." },
      },
      required: ["kind", "label"],
    },
  },
  {
    name: "remove_node",
    description: "Remove a component (and its edges) by id or label.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
    },
  },
  {
    name: "connect",
    description: "Wire one component to another.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source node id or label." },
        to: { type: "string", description: "Target node id or label." },
        kind: { type: "string", enum: ["calls", "streams", "owns", "publishes", "subscribes"] },
        protocol: { type: "string", enum: ["http", "grpc", "sql", "event", "ws", "internal"] },
        label: { type: "string" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "disconnect",
    description: "Remove a wire between two components.",
    input_schema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
  },
];

const OP_BY_TOOL = {
  add_node: (input) => ({ op: "add_node", ...input }),
  remove_node: (input) => ({ op: "remove_node", ref: input.ref }),
  connect: (input) => ({ op: "connect", ...input }),
  disconnect: (input) => ({ op: "disconnect", ...input }),
};

function systemPrompt() {
  return [
    "You are the design assistant inside an architecture canvas.",
    "The user is shaping a system design by dragging components and talking to you.",
    "Translate their intent into tool calls that edit the design — do not describe",
    "changes in prose and expect the user to make them; make them yourself with tools.",
    "After your edits, you receive the current node/edge counts and any constraint",
    "violations. Mention real violations plainly; do not invent problems.",
    "Keep replies short and concrete. Refer to components by their labels.",
  ].join(" ");
}

function topologySummary(spec) {
  const t = spec.views.architecture;
  const nodes = t.nodes.map((n) => `${n.label} (${n.kind}, id=${n.id})`).join(", ") || "none";
  const edges =
    t.edges
      .map((e) => {
        const f = t.nodes.find((n) => n.id === e.from);
        const g = t.nodes.find((n) => n.id === e.to);
        return `${f ? f.label : e.from} -[${e.kind}/${e.protocol}]-> ${g ? g.label : e.to}`;
      })
      .join("; ") || "none";
  const { violations } = lint(spec);
  return { nodes, edges, violations };
}

export async function runAssistant({ userText, spec, model, apiKey }) {
  if (!apiKey) {
    return {
      text:
        "No Anthropic API key found. Set ANTHROPIC_API_KEY or run `adr-doctor setup`, " +
        "then reopen the canvas. (Drag-and-drop editing works without a key.)",
      spec,
      trace: [],
    };
  }

  const client = new Anthropic({ apiKey });
  let working = spec;
  const trace = [];

  const messages = [
    {
      role: "user",
      content:
        `Current design — nodes: ${topologySummary(spec).nodes}. ` +
        `edges: ${topologySummary(spec).edges}.\n\nUser: ${userText}`,
    },
  ];

  // Bounded agentic loop: edit -> lint -> let the model react -> finalize.
  for (let turn = 0; turn < 6; turn++) {
    const res = await client.messages.create({
      model: model || "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt(),
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: res.content });

    const toolUses = res.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      const text = res.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { text: text || "Done.", spec: working, trace };
    }

    const toolResults = [];
    for (const tu of toolUses) {
      const make = OP_BY_TOOL[tu.name];
      let resultPayload;
      try {
        working = applyMutation(working, make(tu.input));
        const sum = topologySummary(working);
        resultPayload = {
          ok: true,
          nodes: working.views.architecture.nodes.length,
          edges: working.views.architecture.edges.length,
          violations: sum.violations,
        };
      } catch (err) {
        resultPayload = { ok: false, error: String(err.message || err) };
      }
      trace.push({ tool: tu.name, input: tu.input, result: resultPayload });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(resultPayload),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    text: "Reached the edit limit for one message — check the canvas and tell me what to adjust.",
    spec: working,
    trace,
  };
}
