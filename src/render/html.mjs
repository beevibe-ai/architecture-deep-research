// Render an ADR.md research report as a standalone HTML file the user can
// open in a browser. The kernel emits a known markdown shape (executive
// summary, option-space table, per-candidate sections, mermaid diagrams,
// references) so this converter targets that shape — not the full
// CommonMark spec.
//
// Mermaid diagrams are kept as `<div class="mermaid">...</div>` blocks; the
// page loads mermaid.js from CDN and auto-renders them to SVG.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(text) {
  let out = escapeHtml(text);
  // Inline code first so backtick content doesn't get further mangled.
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  // Links — match before bold/italic so the URL doesn't get touched.
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label, url) => `<a href="${url}">${label}</a>`
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  return out;
}

function renderTable(rows) {
  const [header, separator, ...body] = rows;
  if (!separator || !/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(separator)) {
    return null;
  }
  const splitRow = (line) =>
    line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((cell) => cell.trim());
  const headerCells = splitRow(header);
  const headHtml = `<thead><tr>${headerCells.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>`;
  const bodyHtml = body
    .map((line) => `<tr>${splitRow(line).map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table>${headHtml}<tbody>${bodyHtml}</tbody></table>`;
}

function renderMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block (including mermaid).
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, "").trim();
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence
      if (lang === "mermaid") {
        blocks.push(`<div class="mermaid">${escapeHtml(codeLines.join("\n"))}</div>`);
      } else {
        const cls = lang ? ` class="language-${lang}"` : "";
        blocks.push(`<pre><code${cls}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      }
      continue;
    }

    // Horizontal rule.
    if (/^---+\s*$/.test(line)) {
      blocks.push("<hr>");
      i += 1;
      continue;
    }

    // Headers.
    const headerMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headerMatch) {
      const level = headerMatch[1].length;
      blocks.push(`<h${level}>${renderInline(headerMatch[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Table (header line + separator line + body).
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const tableLines = [];
      while (i < lines.length && /\|/.test(lines[i])) {
        tableLines.push(lines[i]);
        i += 1;
      }
      const html = renderTable(tableLines);
      if (html) {
        blocks.push(html);
        continue;
      }
    }

    // Unordered list.
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
        i += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Blank line — skip.
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Paragraph — collect consecutive non-empty non-special lines.
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6}\s|```|[-*]\s|\|)/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    if (paraLines.length > 0) {
      blocks.push(`<p>${renderInline(paraLines.join(" "))}</p>`);
    }
  }
  return blocks.join("\n");
}

function htmlTemplate({ title, body, runDir }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
:root {
  --fg: #1f2328;
  --muted: #59636e;
  --bg: #ffffff;
  --bg-alt: #f6f8fa;
  --border: #d0d7de;
  --accent: #0969da;
  --code-bg: #f6f8fa;
  --strong-axes: #1a7f37;
  --weak-axes: #cf222e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e6edf3;
    --muted: #9198a1;
    --bg: #0d1117;
    --bg-alt: #161b22;
    --border: #30363d;
    --accent: #4493f8;
    --code-bg: #161b22;
    --strong-axes: #3fb950;
    --weak-axes: #f85149;
  }
}
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  color: var(--fg);
  background: var(--bg);
  max-width: 920px;
  margin: 0 auto;
  padding: 48px 32px 80px;
}
h1 { font-size: 32px; line-height: 1.25; margin: 0 0 8px; letter-spacing: -0.01em; }
h2 { font-size: 22px; margin: 40px 0 12px; padding-top: 12px; border-top: 1px solid var(--border); letter-spacing: -0.005em; }
h3 { font-size: 18px; margin: 28px 0 8px; }
h4 { font-size: 16px; margin: 20px 0 6px; }
p { margin: 0 0 14px; }
em { color: var(--muted); font-style: italic; }
strong { font-weight: 600; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.88em;
  background: var(--code-bg);
  padding: 1px 5px;
  border-radius: 4px;
}
pre {
  background: var(--code-bg);
  padding: 14px 16px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 0 0 16px;
}
pre code { background: transparent; padding: 0; font-size: 0.85em; }
ul { padding-left: 24px; margin: 0 0 14px; }
li { margin: 4px 0; }
hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
table {
  border-collapse: collapse;
  width: 100%;
  margin: 0 0 20px;
  font-size: 0.92em;
}
th, td {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
th { background: var(--bg-alt); font-weight: 600; }
tr:hover td { background: var(--bg-alt); }
.mermaid {
  background: var(--bg-alt);
  padding: 16px;
  border-radius: 8px;
  margin: 0 0 20px;
  text-align: center;
  overflow-x: auto;
}
.footer-meta {
  margin-top: 56px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 13px;
}
</style>
</head>
<body>
${body}
<div class="footer-meta">Rendered from <code>${escapeHtml(runDir)}/ADR.md</code> by <code>adr open</code>.</div>
<script>
  mermaid.initialize({
    startOnLoad: true,
    theme: window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
    securityLevel: "loose"
  });
</script>
</body>
</html>`;
}

// Render ADR.md from outDir into ADR.html in the same directory.
// Returns the absolute path to the generated HTML file.
async function renderReportHtml({ outDir }) {
  const resolvedDir = path.resolve(outDir);
  const mdPath = path.join(resolvedDir, "ADR.md");
  const htmlPath = path.join(resolvedDir, "ADR.html");
  const md = await readFile(mdPath, "utf8");

  // Pull the first h1 as the page title; fall back to the directory name.
  const titleMatch = /^#\s+(.+)$/m.exec(md);
  const title = titleMatch ? titleMatch[1] : path.basename(resolvedDir);

  const body = renderMarkdown(md);
  const html = htmlTemplate({ title, body, runDir: resolvedDir });
  await writeFile(htmlPath, html, "utf8");
  return htmlPath;
}

export { renderReportHtml };
