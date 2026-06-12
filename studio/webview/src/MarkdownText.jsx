import React, { memo, useMemo } from "react";

function parseInline(text, keyPrefix) {
  const source = String(text || "");
  const nodes = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let i = 0;
  for (const match of source.matchAll(re)) {
    if (match.index > last) nodes.push(source.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-in-${i++}`;
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{parseInline(token.slice(2, -2), key)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{parseInline(token.slice(1, -1), key)}</em>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link?.[2] || "";
      const safe = /^(https?:|mailto:)/i.test(href) ? href : undefined;
      nodes.push(
        safe ? (
          <a key={key} href={safe} target="_blank" rel="noreferrer">
            {parseInline(link[1], key)}
          </a>
        ) : (
          token
        )
      );
    }
    last = match.index + token.length;
  }
  if (last < source.length) nodes.push(source.slice(last));
  return nodes;
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function parseBlocks(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({ type: "code", lang: fence[1] || "", text: code.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ type: "quote", text: quote.join("\n") });
      continue;
    }

    if (/^\s*([-*])\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      const re = ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-*]\s+(.+)$/;
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, "$1"));
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (i + 1 < lines.length && line.includes("|") && isTableSeparator(lines[i + 1])) {
      const head = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitTableRow(lines[i++]));
      blocks.push({ type: "table", head, rows });
      continue;
    }

    const paragraph = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*([-*])\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paragraph.push(lines[i++]);
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

function renderBlock(block, i) {
  const key = `md-${i}`;
  if (block.type === "code") {
    return (
      <pre key={key} className="markdown-code">
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.type === "heading") {
    const Tag = `h${Math.min(block.level, 4)}`;
    return <Tag key={key}>{parseInline(block.text, key)}</Tag>;
  }
  if (block.type === "quote") return <blockquote key={key}>{parseInline(block.text, key)}</blockquote>;
  if (block.type === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return (
      <Tag key={key}>
        {block.items.map((item, j) => <li key={`${key}-${j}`}>{parseInline(item, `${key}-${j}`)}</li>)}
      </Tag>
    );
  }
  if (block.type === "table") {
    return (
      <table key={key}>
        <thead>
          <tr>{block.head.map((cell, j) => <th key={`${key}-h-${j}`}>{parseInline(cell, `${key}-h-${j}`)}</th>)}</tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={`${key}-r-${r}`}>{block.head.map((_cell, c) => <td key={`${key}-r-${r}-${c}`}>{parseInline(row[c] || "", `${key}-r-${r}-${c}`)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    );
  }
  return <p key={key}>{parseInline(block.text, key)}</p>;
}

function MarkdownText({ text, className = "" }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <div className={`markdown-text ${className}`}>{blocks.map(renderBlock)}</div>;
}

export default memo(MarkdownText);
