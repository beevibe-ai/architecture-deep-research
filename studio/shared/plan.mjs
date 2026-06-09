// Hybrid plan.md generator. The structure — tables, component lists, Mermaid
// diagrams — is generated deterministically from the IR, so it is always in
// sync and never hallucinated. AI-authored prose (spec.plan.sections, source
// "ai") is spliced in at named anchors. This follows the buildADR pattern from
// src/kernel.mjs: an array of lines joined with "\n", Markdown tables, and
// fenced ```mermaid blocks.

import { lint } from "./constraints.mjs";

// Pipe-escape for table cells (ported from src/principles/render-markdown.mjs).
function esc(v) {
  return String(v == null ? "" : v).replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

// Relaxed Mermaid validator — the kernel's (src/kernel.mjs:66-93) accepts only
// `flowchart`, which would reject ER diagrams. Accept the three headers we emit,
// reject triple-backtick contamination, require balanced brackets.
export function validateMermaid(source) {
  if (!source || typeof source !== "string") return { ok: false, error: "empty" };
  const head = source.trim().split(/\s+/)[0];
  if (!/^(flowchart|erDiagram|stateDiagram(-v2)?)$/.test(head))
    return { ok: false, error: `unexpected header "${head}"` };
  if (source.includes("```")) return { ok: false, error: "contains code fence" };
  // Only balance the label brackets [] and (). Braces {} are intentionally
  // skipped: erDiagram crow's-foot cardinality (||--o{) uses unbalanced braces.
  for (const [open, close] of [["[", "]"], ["(", ")"]]) {
    const o = source.split(open).length - 1;
    const c = source.split(close).length - 1;
    if (o !== c) return { ok: false, error: `unbalanced ${open}${close}` };
  }
  return { ok: true };
}

// Strip characters that break Mermaid node labels.
function safeLabel(s) {
  return String(s || "").replace(/["[\]{}()|]/g, "").replace(/\s+/g, " ").trim() || "node";
}

function fence(dsl) {
  const v = validateMermaid(dsl);
  return v.ok ? ["```mermaid", dsl, "```", ""] : [];
}

// Pull an AI-authored section body by anchor id, or "" if none.
function aiBody(spec, id) {
  const s = (spec.plan?.sections || []).find((x) => x.id === id && x.source === "ai");
  return s ? s.body_md : "";
}

export function generatePlan(spec) {
  const L = [];
  const arch = spec.views.architecture;
  const dm = spec.views.data_model;
  const flows = spec.views.flows;
  const { violations } = lint(spec);

  L.push(`# ${spec.decision?.title || "Untitled architecture"}`, "");
  L.push(
    `_status: ${spec.decision?.status || "draft"} · ${arch.nodes.length} components · ` +
      `${dm.entities.length} entities · ${flows.length} flows · ` +
      `${violations.length ? `${violations.length} open issue(s)` : "design clean"}_`,
    ""
  );

  // Overview — AI prose if present, else a deterministic stub.
  L.push("## Overview", "");
  L.push(aiBody(spec, "overview") || "_A system design authored in the architecture canvas._", "");

  // Components
  if (arch.nodes.length) {
    L.push("## Components", "");
    L.push("| Component | Kind | Tech | Context | Intent |", "| --- | --- | --- | --- | --- |");
    for (const n of arch.nodes)
      L.push(`| ${esc(n.label)} | ${esc(n.kind)} | ${esc(n.tech)} | ${esc(n.context)} | ${esc(n.notes)} |`);
    L.push("");
    L.push(...fence(architectureMermaid(spec)));
  }

  // Data model
  if (dm.entities.length) {
    L.push("## Data model", "");
    for (const e of dm.entities) {
      L.push(`### ${esc(e.name)}`, "");
      L.push("| Field | Type | Key | Nullable |", "| --- | --- | --- | --- |");
      for (const f of e.fields)
        L.push(`| ${esc(f.name)} | ${esc(f.type)} | ${f.pk ? "PK" : f.fk ? "FK" : ""} | ${f.nullable === false ? "no" : "yes"} |`);
      L.push("");
    }
    L.push(...fence(erMermaid(spec)));
  }

  // Flows
  if (flows.length) {
    L.push("## Flows", "");
    for (const flow of flows) {
      L.push(`### ${esc(flow.name)}`, "");
      L.push(...fence(flowMermaid(flow)));
    }
  }

  // Cross-references
  if ((spec.cross_refs || []).length) {
    L.push("## Cross-references", "");
    L.push("| From | Kind | To |", "| --- | --- | --- |");
    for (const x of spec.cross_refs)
      L.push(`| ${esc(refLabel(spec, x.from))} | ${esc(x.kind)} | ${esc(refLabel(spec, x.to))} |`);
    L.push("");
  }

  // Invariants + constraints
  const invariants = spec.domain_model?.domain_invariants || [];
  if (invariants.length) {
    L.push("## Invariants", "");
    for (const inv of invariants) L.push(`- ${inv}`);
    L.push("");
  }
  if ((spec.constraints || []).length) {
    L.push("## Constraints", "");
    L.push("| Rule | View | Message |", "| --- | --- | --- |");
    for (const c of spec.constraints)
      L.push(`| ${esc(c.rule)} | ${esc(c.view)} | ${esc(c.message || "")} |`);
    L.push("");
  }

  if (violations.length) {
    L.push("## Open issues", "");
    for (const v of violations) L.push(`- ${esc(v.message)}`);
    L.push("");
  }

  // Trailing AI sections (rationale, tradeoffs, …) not already anchored above.
  for (const s of spec.plan?.sections || []) {
    if (s.source === "ai" && s.id !== "overview") {
      L.push(`## ${esc(s.title || s.id)}`, "", s.body_md, "");
    }
  }

  return L.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function refLabel(spec, end) {
  if (end.view === "architecture") return (spec.views.architecture.nodes.find((n) => n.id === end.ref) || {}).label || end.ref;
  if (end.view === "data_model") return (spec.views.data_model.entities.find((e) => e.id === end.ref) || {}).name || end.ref;
  if (end.view === "flows") {
    for (const f of spec.views.flows) {
      const s = f.nodes.find((n) => n.id === end.ref);
      if (s) return `${f.name}/${s.label}`;
    }
  }
  return end.ref;
}

// ---- Mermaid builders ------------------------------------------------------
export function architectureMermaid(spec) {
  const { nodes, edges } = spec.views.architecture;
  const lines = ["flowchart LR"];
  for (const n of nodes) lines.push(`  ${n.id}["${safeLabel(n.label)}"]`);
  for (const e of edges) lines.push(`  ${e.from} -->|${safeLabel(e.protocol)}| ${e.to}`);
  return lines.join("\n");
}

export function erMermaid(spec) {
  const { entities, relations } = spec.views.data_model;
  const lines = ["erDiagram"];
  for (const e of entities) {
    const name = safeLabel(e.name).replace(/\s/g, "_").toUpperCase();
    lines.push(`  ${name} {`);
    for (const f of e.fields) lines.push(`    ${safeLabel(f.type)} ${safeLabel(f.name)}${f.pk ? " PK" : f.fk ? " FK" : ""}`);
    lines.push("  }");
  }
  const card = { "1:1": "||--||", "1:N": "||--o{", "N:M": "}o--o{" };
  const nameOf = (id) => safeLabel((entities.find((e) => e.id === id) || {}).name || id).replace(/\s/g, "_").toUpperCase();
  for (const r of relations) lines.push(`  ${nameOf(r.from)} ${card[r.cardinality] || "||--o{"} ${nameOf(r.to)} : ${safeLabel(r.label) || "rel"}`);
  return lines.join("\n");
}

export function flowMermaid(flow) {
  const lines = ["flowchart TD"];
  for (const n of flow.nodes) {
    const l = safeLabel(n.label);
    if (n.type === "decision") lines.push(`  ${n.id}{"${l}"}`);
    else if (n.type === "start" || n.type === "end") lines.push(`  ${n.id}(["${l}"])`);
    else lines.push(`  ${n.id}["${l}"]`);
  }
  for (const t of flow.transitions)
    lines.push(t.label ? `  ${t.from} -->|${safeLabel(t.label)}| ${t.to}` : `  ${t.from} --> ${t.to}`);
  return lines.join("\n");
}
