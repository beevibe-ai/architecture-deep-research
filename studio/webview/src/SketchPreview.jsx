import React, { memo, useMemo } from "react";
import { extractFirstMermaid } from "../../shared/sketch.mjs";

const NODE_W = 158;
const NODE_H = 54;
const PAD_X = 56;
const PAD_Y = 42;
const GAP_X = 96;
const GAP_Y = 76;

function cleanLabel(text) {
  return String(text || "")
    .replace(/^["']|["']$/g, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseEndpoint(raw) {
  const text = String(raw || "").trim().replace(/;$/, "");
  const match = text.match(/^([A-Za-z][A-Za-z0-9_]*)\s*(?:\["([^"]+)"\]|\[([^\]]+)\]|\("([^"]+)"\)|\(([^)]+)\)|\{([^}]+)\})?$/);
  if (!match) return null;
  return {
    id: match[1],
    label: cleanLabel(match[2] || match[3] || match[4] || match[5] || match[6] || match[1]),
  };
}

function parseFlowchart(source) {
  const lines = String(source || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("%%"));
  const header = lines.shift() || "";
  const head = header.match(/^(?:flowchart|graph)\s+(TD|TB|LR|RL)/i);
  if (!head) return null;
  const direction = head[1].toUpperCase();
  const nodes = new Map();
  const edges = [];

  for (const line of lines) {
    if (/^(subgraph|end\b)/i.test(line)) continue;
    const edge = line.match(/^(.+?)\s*(?:-->|---|-.->|==>)\s*(?:\|([^|]+)\|\s*)?(.+)$/);
    if (edge) {
      const from = parseEndpoint(edge[1]);
      const to = parseEndpoint(edge[3]);
      if (!from || !to) return null;
      nodes.set(from.id, { ...nodes.get(from.id), ...from });
      nodes.set(to.id, { ...nodes.get(to.id), ...to });
      edges.push({ from: from.id, to: to.id, label: cleanLabel(edge[2] || "") });
      continue;
    }
    const node = parseEndpoint(line);
    if (node) nodes.set(node.id, { ...nodes.get(node.id), ...node });
  }
  if (!nodes.size) return null;
  return { direction, nodes: [...nodes.values()], edges };
}

function layoutGraph(graph) {
  const rank = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < graph.nodes.length; i++) {
    let changed = false;
    for (const e of graph.edges) {
      const next = Math.max(rank.get(e.to) || 0, (rank.get(e.from) || 0) + 1);
      if (next !== rank.get(e.to)) {
        rank.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const groups = new Map();
  for (const n of graph.nodes) {
    const r = rank.get(n.id) || 0;
    groups.set(r, [...(groups.get(r) || []), n]);
  }
  const ranked = [...groups.entries()].sort((a, b) => a[0] - b[0]);
  const maxGroup = Math.max(...ranked.map(([, list]) => list.length), 1);
  const maxRank = Math.max(...ranked.map(([r]) => r), 0);
  const lr = graph.direction === "LR" || graph.direction === "RL";
  const width = lr ? PAD_X * 2 + (maxRank + 1) * NODE_W + maxRank * GAP_X : PAD_X * 2 + maxGroup * NODE_W + Math.max(0, maxGroup - 1) * GAP_X;
  const height = lr ? PAD_Y * 2 + maxGroup * NODE_H + Math.max(0, maxGroup - 1) * GAP_Y : PAD_Y * 2 + (maxRank + 1) * NODE_H + maxRank * GAP_Y;
  const positions = new Map();

  for (const [r, list] of ranked) {
    const rowWidth = list.length * NODE_W + Math.max(0, list.length - 1) * GAP_X;
    const rowHeight = list.length * NODE_H + Math.max(0, list.length - 1) * GAP_Y;
    list.forEach((n, i) => {
      const x = lr ? PAD_X + r * (NODE_W + GAP_X) : (width - rowWidth) / 2 + i * (NODE_W + GAP_X);
      const y = lr ? (height - rowHeight) / 2 + i * (NODE_H + GAP_Y) : PAD_Y + r * (NODE_H + GAP_Y);
      positions.set(n.id, { x, y });
    });
  }
  return { width, height, positions };
}

function splitLabel(label) {
  const words = cleanLabel(label).split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > 20 && current) {
      lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 3);
}

function SketchSvg({ graph }) {
  const layout = layoutGraph(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return (
    <svg className="sketch-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="Freeform diagram sketch">
      <defs>
        <marker id="sketch-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      {graph.edges.map((edge, index) => {
        const from = layout.positions.get(edge.from);
        const to = layout.positions.get(edge.to);
        if (!from || !to) return null;
        const x1 = from.x + NODE_W;
        const y1 = from.y + NODE_H / 2;
        const x2 = to.x;
        const y2 = to.y + NODE_H / 2;
        const mid = (x1 + x2) / 2;
        const d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
        return (
          <g key={`${edge.from}-${edge.to}-${index}`} className="sketch-edge">
            <path d={d} markerEnd="url(#sketch-arrow)" />
            {edge.label && (
              <text x={mid} y={(y1 + y2) / 2 - 6} textAnchor="middle">
                {edge.label.slice(0, 26)}
              </text>
            )}
          </g>
        );
      })}
      {graph.nodes.map((node) => {
        const p = layout.positions.get(node.id);
        const lines = splitLabel(byId.get(node.id)?.label || node.id);
        return (
          <g key={node.id} className="sketch-node" transform={`translate(${p.x} ${p.y})`}>
            <rect width={NODE_W} height={NODE_H} rx="8" />
            {lines.map((line, i) => (
              <text key={line} x={NODE_W / 2} y={22 + i * 14} textAnchor="middle">
                {line}
              </text>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

function SketchPreview({ markdown = "" }) {
  const parsed = useMemo(() => {
    const block = extractFirstMermaid(markdown);
    return block ? { block, graph: parseFlowchart(block.source) } : null;
  }, [markdown]);

  if (!parsed?.block) return <div className="sketch-empty">No sketch returned.</div>;
  return (
    <div className="sketch-preview">
      {parsed.graph ? <SketchSvg graph={parsed.graph} /> : <pre className="sketch-code">{parsed.block.source}</pre>}
    </div>
  );
}

export default memo(SketchPreview);
