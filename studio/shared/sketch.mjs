// Freeform diagram sketches. These are proposal artifacts, not the canonical
// editable IR. The canvas can still apply the structured architecture option.

function esc(v) {
  return String(v == null ? "" : v).replace(/"/g, "'").replace(/\s+/g, " ").trim();
}

function safeId(id, fallback) {
  const clean = String(id || fallback || "node").replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[a-zA-Z]/.test(clean) ? clean : `n_${clean}`;
}

function nodeLabel(n) {
  const type = n.type && n.type !== n.kind ? n.type : n.kind;
  return esc([n.label, type].filter(Boolean).join(" / "));
}

function edgeLabel(e) {
  return esc([e.label, e.protocol, e.kind !== "calls" ? e.kind : ""].filter(Boolean).join(" / "));
}

export function extractFirstMermaid(markdown = "") {
  const match = String(markdown).match(/```mermaid\s*\n([\s\S]*?)```/i);
  if (!match) return null;
  const source = match[1].trim();
  const head = source.split(/\s+/)[0] || "";
  return { source, head };
}

export function architectureSketchMermaid(spec) {
  const arch = spec?.views?.architecture || { nodes: [], edges: [] };
  const nodes = arch.nodes || [];
  const visible = nodes.filter((n) => !n.parent);
  const lines = ["flowchart TD"];
  if (!visible.length) {
    lines.push('  empty["No architecture components yet"]');
    return lines.join("\n");
  }

  const ids = new Map();
  visible.forEach((n, index) => ids.set(n.id, safeId(n.id, `node_${index}`)));
  for (const n of visible) lines.push(`  ${ids.get(n.id)}["${nodeLabel(n)}"]`);
  for (const e of arch.edges || []) {
    const from = ids.get(e.from);
    const to = ids.get(e.to);
    if (!from || !to) continue;
    const label = edgeLabel(e);
    lines.push(label ? `  ${from} -->|"${label}"| ${to}` : `  ${from} --> ${to}`);
  }
  return lines.join("\n");
}

export function architectureSketchMarkdown(spec, { title = "Diagram sketch" } = {}) {
  return [`### ${title}`, "", "```mermaid", architectureSketchMermaid(spec), "```"].join("\n");
}

export function normalizeSketchMarkdown(markdown, spec, opts = {}) {
  const mermaid = extractFirstMermaid(markdown);
  if (mermaid?.source) return ["```mermaid", mermaid.source, "```"].join("\n");
  return architectureSketchMarkdown(spec, opts);
}
