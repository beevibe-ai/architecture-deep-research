// The design assistant. It never returns prose for someone to re-key — it edits
// the IR through tools, the exact same applyMutation path drag-drop uses, now
// spanning all three views. Responses stream token-by-token; after each applied
// tool call the working spec is pushed back so every canvas animates mid-stream.
// The model sees lint feedback per turn and can self-correct.

import { applyMutation } from "../shared/ir.mjs";
import { lint } from "../shared/constraints.mjs";
import { catalogVocabulary } from "../shared/catalog.mjs";
import { infraVocabulary } from "../shared/infra.mjs";
import { makeProvider, defaultModel } from "./providers.mjs";

// View-namespaced tools so the model never edits the wrong view.
const TOOLS = [
  // architecture
  { name: "arch_add_node", description: "Add a component. Prefer a catalog `type` (orchestrator, semantic_gateway, vector_db, search_index, event_queue, otel_collector, rbac_policy, …) — it sets the category, plane, and tech options.", input_schema: { type: "object", properties: { type: { type: "string", description: "catalog component type id" }, label: { type: "string" }, tech: { type: "string", description: "specific tech, e.g. pgvector, SQLite FTS5, Kafka" }, plane: { type: "string", enum: ["control", "execution", "data"] }, context: { type: "string" }, notes: { type: "string", description: "design intent for the coding agent" } }, required: ["type", "label"] } },
  { name: "arch_set_edge_semantics", description: "Set distributed/governance/observability properties on a wire.", input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, protocol: { type: "string" }, delivery: { type: "string", enum: ["best-effort", "at-least-once", "exactly-once", "ordered"] }, consistency: { type: "string", enum: ["none", "eventual", "linearizable", "vector_clock", "lamport"] }, required_role: { type: "string", description: "RBAC role required to traverse this edge" }, instrumented: { type: "boolean", description: "OTel-traced" } }, required: ["from", "to"] } },
  { name: "arch_remove_node", description: "Remove a component by id or label.", input_schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] } },
  { name: "arch_connect", description: "Wire one component to another.", input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, kind: { type: "string", enum: ["calls", "streams", "owns", "publishes", "subscribes"] }, protocol: { type: "string", enum: ["http", "grpc", "sql", "event", "ws", "internal"] }, label: { type: "string" } }, required: ["from", "to"] } },
  { name: "arch_disconnect", description: "Remove a wire between two components.", input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] } },
  // data model
  { name: "dm_create_entity", description: "Create a data-model entity with its fields.", input_schema: { type: "object", properties: { name: { type: "string" }, context: { type: "string" }, fields: { type: "array", items: { type: "object", properties: { name: { type: "string" }, type: { type: "string" }, pk: { type: "boolean" }, nullable: { type: "boolean" } }, required: ["name"] } } }, required: ["name"] } },
  { name: "dm_add_field", description: "Add a field to an entity.", input_schema: { type: "object", properties: { entity: { type: "string" }, name: { type: "string" }, type: { type: "string" }, pk: { type: "boolean" } }, required: ["entity", "name"] } },
  { name: "dm_add_relation", description: "Relate two entities.", input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, cardinality: { type: "string", enum: ["1:1", "1:N", "N:M"] }, label: { type: "string" } }, required: ["from", "to"] } },
  { name: "dm_remove_entity", description: "Remove an entity by id or name.", input_schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] } },
  // flows
  { name: "flow_create_flow", description: "Create a flowchart with its steps and transitions.", input_schema: { type: "object", properties: { name: { type: "string" }, steps: { type: "array", items: { type: "object", properties: { type: { type: "string", enum: ["start", "process", "decision", "end"] }, label: { type: "string" } }, required: ["type", "label"] } }, transitions: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" } }, required: ["from", "to"] } } }, required: ["name"] } },
  { name: "flow_add_step", description: "Add a step to a flow.", input_schema: { type: "object", properties: { flow: { type: "string" }, type: { type: "string", enum: ["start", "process", "decision", "end"] }, label: { type: "string" } }, required: ["flow", "type", "label"] } },
  { name: "flow_add_transition", description: "Connect two steps in a flow.", input_schema: { type: "object", properties: { flow: { type: "string" }, from: { type: "string" }, to: { type: "string" }, label: { type: "string" } }, required: ["flow", "from", "to"] } },
  // composite + cross-cutting
  { name: "scaffold_subsystem", description: "Create a service + datastore + wire + owned entity + cross_ref in one step.", input_schema: { type: "object", properties: { name: { type: "string" }, service: { type: "string" }, datastore: { type: "string" }, entity: { type: "string" }, tech: { type: "string" }, context: { type: "string" } }, required: ["name"] } },
  { name: "scaffold_runtime", description: "Create an Agent Runtime container with its five internals nested inside (State Manager, Task Queue, Scheduler, Logger, Monitor).", input_schema: { type: "object", properties: { label: { type: "string" } } } },
  // infrastructure (deployment)
  { name: "infra_add", description: "Add an infra node (cluster, namespace, node_pool, deployment, statefulset, service, ingress, pvc, hpa, keda_scaledobject, kserve_inference, vllm, managed_postgres, dynamodb, s3, image, …). Pass parent (label/id of a container) to nest it.", input_schema: { type: "object", properties: { type: { type: "string" }, label: { type: "string" }, parent: { type: "string" }, props: { type: "object" } }, required: ["type", "label"] } },
  { name: "infra_connect", description: "Connect two infra nodes (exposes/routes/mounts/scales/backs/pulls/schedules).", input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, kind: { type: "string", enum: ["exposes", "routes", "mounts", "scales", "backs", "pulls", "schedules"] } }, required: ["from", "to", "kind"] } },
  { name: "infra_set_props", description: "Set config props on an infra node (image, replicas, cpu, memory, gpu, size, min, max, trigger, …).", input_schema: { type: "object", properties: { ref: { type: "string" }, props: { type: "object" } }, required: ["ref", "props"] } },
  { name: "deploy_realize", description: "Link a logical component to the infra node that deploys it.", input_schema: { type: "object", properties: { component: { type: "string" }, infra: { type: "string" } }, required: ["component", "infra"] } },
  { name: "class_add", description: "Add a UML class with its members.", input_schema: { type: "object", properties: { name: { type: "string" }, stereotype: { type: "string", enum: ["abstract", "interface"] }, members: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["attribute", "method"] }, name: { type: "string" }, type: { type: "string" }, visibility: { type: "string" } }, required: ["kind", "name"] } } }, required: ["name"] } },
  { name: "class_connect", description: "Relate two classes (inherits/implements/associates/composes/aggregates).", input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, kind: { type: "string", enum: ["inherits", "implements", "associates", "composes", "aggregates"] } }, required: ["from", "to", "kind"] } },
  { name: "seq_create", description: "Create a sequence diagram with participants and ordered messages.", input_schema: { type: "object", properties: { name: { type: "string" }, participants: { type: "array", items: { type: "string" } }, messages: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" }, type: { type: "string", enum: ["sync", "async", "return"] } }, required: ["from", "to"] } } }, required: ["name"] } },
  { name: "add_note", description: "Capture a requirement, idea, decision, question, or risk in the Notes panel.", input_schema: { type: "object", properties: { kind: { type: "string", enum: ["functional", "non_functional", "idea", "question", "decision", "risk"] }, title: { type: "string" }, body: { type: "string" }, priority: { type: "string", enum: ["must", "should", "could", "wont"] } }, required: ["kind", "title"] } },
  { name: "write_plan_section", description: "Write or replace an AI prose section of plan.md (e.g. overview, rationale, tradeoffs).", input_schema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, body_md: { type: "string" } }, required: ["id", "body_md"] } },
  { name: "run_constraint_check", description: "Return the current constraint violations without changing anything.", input_schema: { type: "object", properties: {} } },
  { name: "auto_layout", description: "Auto-arrange a view into a clean layout (dagre, like Mermaid). Use after adding several nodes so the diagram stays tidy.", input_schema: { type: "object", properties: { view: { type: "string", enum: ["architecture", "data_model", "flows", "infra"] }, direction: { type: "string", enum: ["TB", "LR"] } }, required: ["view"] } },
];

// Map a tool call to one or more IR mutations. Returns [] for run_constraint_check
// (a read-only tool handled by the loop).
function toolToMutations(name, input) {
  switch (name) {
    case "arch_add_node":
      return [{ op: "add_node", view: "architecture", ...input }];
    case "arch_set_edge_semantics":
      return [{ op: "set_edge_semantics", view: "architecture", ...input }];
    case "arch_remove_node":
      return [{ op: "remove_node", view: "architecture", ref: input.ref }];
    case "arch_connect":
      return [{ op: "connect", view: "architecture", ...input }];
    case "arch_disconnect":
      return [{ op: "disconnect", view: "architecture", ...input }];
    case "dm_create_entity":
      return [{ op: "add_entity", view: "data_model", name: input.name, context: input.context, fields: input.fields || [] }];
    case "dm_add_field":
      return [{ op: "add_field", view: "data_model", ...input }];
    case "dm_add_relation":
      return [{ op: "add_relation", view: "data_model", ...input }];
    case "dm_remove_entity":
      return [{ op: "remove_entity", view: "data_model", ref: input.ref }];
    case "flow_create_flow": {
      const muts = [{ op: "add_flow", view: "flows", name: input.name }];
      for (const s of input.steps || []) muts.push({ op: "add_step", view: "flows", flow: input.name, type: s.type, label: s.label });
      for (const t of input.transitions || []) muts.push({ op: "add_transition", view: "flows", flow: input.name, from: t.from, to: t.to, label: t.label });
      return muts;
    }
    case "flow_add_step":
      return [{ op: "add_step", view: "flows", ...input }];
    case "flow_add_transition":
      return [{ op: "add_transition", view: "flows", ...input }];
    case "scaffold_subsystem":
      return [{ op: "scaffold_subsystem", ...input }];
    case "scaffold_runtime":
      return [{ op: "scaffold_runtime", ...input }];
    case "infra_add":
      return [{ op: "add_infra", view: "infra", ...input }];
    case "infra_connect":
      return [{ op: "connect_infra", view: "infra", ...input }];
    case "infra_set_props":
      return [{ op: "set_infra_props", view: "infra", ref: input.ref, props: input.props }];
    case "deploy_realize":
      return [{ op: "realize", component: input.component, infra: input.infra }];
    case "class_add":
      return [{ op: "add_class", view: "classes", ...input }];
    case "class_connect":
      return [{ op: "connect_class", view: "classes", ...input }];
    case "seq_create": {
      const muts = [{ op: "add_sequence", view: "sequences", name: input.name }];
      for (const p of input.participants || []) muts.push({ op: "add_participant", view: "sequences", seq: input.name, label: p });
      for (const msg of input.messages || []) muts.push({ op: "add_message", view: "sequences", seq: input.name, from: msg.from, to: msg.to, label: msg.label, type: msg.type });
      return muts;
    }
    case "add_note":
      return [{ op: "add_note", ...input }];
    case "auto_layout":
      return [{ op: "auto_layout", ...input }];
    case "write_plan_section":
      return [{ op: "set_plan_section", ...input }];
    case "run_constraint_check":
      return [];
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function systemPrompt(catalog) {
  return [
    "You are the design assistant inside a system-architecture canvas with views:",
    "architecture, data model, flows, infrastructure, classes, sequences.",
    "CRITICAL: You change the design ONLY by calling tools, and you call them in the SAME response.",
    "Never reply with a plan and stop. If you say you will add or change something, you MUST call the",
    "tools to do it in that same turn — do not narrate intentions without acting. After you finish all",
    "the edits, give a one-line confirmation. Use the view-prefixed tools (arch_, dm_, flow_, infra_, class_).",
    "Speak agent-native and distributed-systems language: pick precise component types from the catalog",
    "below, place them on the right plane (control / execution / data), choose specific tech (pgvector,",
    "SQLite FTS5, Kafka, Qdrant…), and set edge semantics with arch_set_edge_semantics —",
    "delivery/consistency (incl. vector_clock) for distributed guarantees, required_role for RBAC,",
    "instrumented for OTel traceability. Route external traffic through a gateway/semantic_gateway and",
    "put a vector_db behind an embedder. Refer to existing elements by label. After edits you receive",
    "counts and violations; fix real ones. Capture rationale with write_plan_section. Keep replies short.",
    "For deployment, use the infra_* tools to build the Infrastructure view (cluster ▸ namespace ▸",
    "workload ▸ pod, node pools, services, PVCs, KEDA/HPA, KServe/vLLM, managed cloud) and deploy_realize",
    "to link a logical component to the infra node that runs it.",
    "\n\nComponent catalog:\n" + catalogVocabulary(catalog),
    "\n\nInfrastructure catalog:\n" + infraVocabulary(),
  ].join(" ");
}

// Compact full-IR context so the model grounds across all three views.
function specSummary(spec) {
  const a = spec.views.architecture;
  const dm = spec.views.data_model;
  const flows = spec.views.flows;
  const comps = a.nodes.map((n) => `${n.label}(${n.kind})`).join(", ") || "none";
  const wires = a.edges.map((e) => `${label(a.nodes, e.from)}→${label(a.nodes, e.to)}[${e.protocol}]`).join(", ") || "none";
  const ents = dm.entities.map((e) => `${e.name}{${e.fields.map((f) => f.name + (f.pk ? "*" : "")).join(",")}}`).join(", ") || "none";
  const fl = flows.map((f) => `${f.name}(${f.nodes.length} steps)`).join(", ") || "none";
  const { violations } = lint(spec);
  return `components: ${comps}\nwiring: ${wires}\nentities: ${ents}\nflows: ${fl}\nviolations: ${violations.length}`;
}
const label = (nodes, id) => (nodes.find((n) => n.id === id) || {}).label || id;

// onEvent receives { type: "chatToken"|"specPatch", ... }. The host wires it to
// postMessage. `client` is injectable for tests (no network).
export async function runAssistant({ userText, spec, model, apiKey, onEvent = () => {}, client, catalog, provider }) {
  // An injected client (tests) always uses the Anthropic shape.
  const providerName = client ? "anthropic" : provider || "anthropic";
  if (!apiKey && !client) {
    const hint = providerName === "openai"
      ? "No OpenAI API key found. Run “ADR Studio: Set Anthropic API Key” (pick OpenAI) or set OPENAI_API_KEY."
      : "No Anthropic API key found. Run “ADR Studio: Set Anthropic API Key”, or set ANTHROPIC_API_KEY.";
    return { text: hint + " (Drag-and-drop editing works without a key.)", spec, trace: [] };
  }

  const prov = makeProvider(providerName, { apiKey, client });
  const useModel = model || defaultModel(providerName);
  let working = spec;
  const trace = [];
  let anyToolUse = false; // did the model call any tool this run?
  let nudged = false;
  const history = [{ role: "user", text: `Current design:\n${specSummary(spec)}\n\nUser: ${userText}` }];

  for (let turn = 0; turn < 8; turn++) {
    const { blocks } = await prov.stream({
      system: systemPrompt(catalog),
      tools: TOOLS,
      model: useModel,
      history,
      maxTokens: 1500,
      onText: (t) => onEvent({ type: "chatToken", text: t }),
    });
    history.push({ role: "assistant", blocks });

    const toolUses = blocks.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      // Safety net: if the model narrated intent but never called a tool, push it to act.
      if (!anyToolUse && !nudged) {
        nudged = true;
        history.push({ role: "user", text: "Apply those changes now by calling the tools — do not just describe them." });
        continue;
      }
      return { text: text || "Done.", spec: working, trace };
    }
    anyToolUse = true;

    const results = [];
    for (const tu of toolUses) {
      let payload;
      try {
        const muts = toolToMutations(tu.name, tu.input || {});
        for (const m of muts) working = applyMutation(working, m);
        const { violations } = lint(working);
        payload = { ok: true, applied: muts.length, violations };
        if (muts.length) onEvent({ type: "specPatch", spec: working });
      } catch (err) {
        payload = { ok: false, error: String(err.message || err) };
      }
      trace.push({ tool: tu.name, input: tu.input, result: payload });
      results.push({ tool_use_id: tu.id, content: JSON.stringify(payload) });
    }
    history.push({ role: "tool", results });
  }

  return { text: "Reached the edit limit for one message — check the canvas and tell me what to adjust.", spec: working, trace };
}
