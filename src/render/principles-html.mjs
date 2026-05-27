// Render principles.json into a self-contained, interactive principles.html
// report. Single file, no build step, CDN deps. Renders:
//
//   - Hero with product identity + stats bar
//   - Architectural intent / philosophy / non-goals cards
//   - Code map (lens ↔ files matrix you can click + filter)
//   - Per-lens accordion with principles, citations, evolvability stats
//   - Health snapshot — stale citations highlighted inline
//
// Citations link via `vscode://file/<abs-path>:<line>` so clicking opens
// the file in the user's editor. Filter chips re-render via vanilla JS
// without a build step. Sits next to `adr open` (which renders ADR.md).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function escapeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadOptional(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function severityClass(confidence) {
  if (confidence === "high") return "conf-high";
  if (confidence === "low") return "conf-low";
  return "conf-medium";
}

function fileFromCite(cite) {
  if (!cite) return null;
  const [p] = String(cite).split(":");
  return p || null;
}

function lineFromCite(cite) {
  if (!cite) return null;
  const parts = String(cite).split(":");
  if (parts.length < 2) return null;
  const m = parts[1].match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

// Build the lens × file map used by the Code Map section. For each file,
// collect which lenses + principles touch it.
function buildCodeMap(artifact) {
  const fileMap = new Map();
  const lensList = artifact.lenses || [];
  for (const p of artifact.principles || []) {
    const cites = [
      ...(p.evidence_cite || []),
      ...(p.examples_to_follow || [])
    ];
    for (const cite of cites) {
      const f = fileFromCite(cite);
      if (!f) continue;
      if (!fileMap.has(f)) {
        fileMap.set(f, { file: f, lenses: new Set(), principles: new Set() });
      }
      const entry = fileMap.get(f);
      entry.lenses.add(p.lens || "");
      entry.principles.add(p.id);
    }
  }
  const files = [...fileMap.values()]
    .map((e) => ({
      file: e.file,
      lenses: [...e.lenses],
      principles: [...e.principles]
    }))
    .sort((a, b) => b.principles.length - a.principles.length);
  return { files, lensList };
}

function renderCitations(cites, repoPath) {
  if (!cites || cites.length === 0) return "";
  return cites
    .map((cite) => {
      const file = fileFromCite(cite);
      const line = lineFromCite(cite);
      const abs = file ? path.resolve(repoPath, file) : null;
      const href = abs
        ? `vscode://file/${abs}${line ? `:${line}` : ""}`
        : "#";
      return `<a class="cite" href="${escapeHtml(href)}">${escapeHtml(cite)}</a>`;
    })
    .join(" ");
}

function statSummary(stats, principleId) {
  const slot = stats?.by_principle?.[principleId];
  if (!slot) return null;
  const total = slot.total_seen || 0;
  if (total === 0) return null;
  return {
    total,
    accepted: slot.accepted || 0,
    edited: slot.edited || 0,
    skipped: slot.skipped || 0,
    skipRate: total > 0 ? slot.skipped / total : 0
  };
}

function healthSummary(health, principleId) {
  if (!health?.by_principle) return null;
  return health.by_principle.find((p) => p.principle_id === principleId) || null;
}

function renderPrinciplesHtmlString({ artifact, stats, health, repoPath }) {
  const productIntent = artifact.product_intent || {};
  const identity = productIntent.identity || "";
  const archIntent = productIntent.architectural_intent || [];
  const philosophy = productIntent.product_philosophy || [];
  const nonGoals = productIntent.non_goals || [];
  const lenses = artifact.lenses || [];
  const principles = artifact.principles || [];
  const codeMap = buildCodeMap(artifact);

  const lensBySlug = new Map(lenses.map((l) => [l.slug, l]));
  const principlesByLens = new Map();
  for (const lens of lenses) principlesByLens.set(lens.slug, []);
  for (const p of principles) {
    if (!principlesByLens.has(p.lens)) principlesByLens.set(p.lens, []);
    principlesByLens.get(p.lens).push(p);
  }

  const totalCitations = principles.reduce(
    (n, p) => n + (p.evidence_cite?.length || 0),
    0
  );
  const staleCitations = health?.stale_citation_count || 0;

  const lensChipsHtml = lenses
    .map(
      (l) => `
      <button class="chip lens-chip" data-lens="${escapeHtml(l.slug)}">${escapeHtml(l.name)}</button>`
    )
    .join("");

  const archHtml = archIntent.length
    ? `
    <section class="section">
      <div class="shell">
        <h2>Architectural intent</h2>
        <p class="section-sub">Foundational decisions everything else hangs off of.</p>
        <div class="card-grid">
          ${archIntent
            .map(
              (item) => `
          <div class="card arch-card">
            <h3>${escapeHtml(item.name)}</h3>
            ${item.why ? `<p>${escapeHtml(item.why)}</p>` : ""}
            ${
              item.evidence_cite?.length
                ? `<div class="citations">${renderCitations(item.evidence_cite, repoPath)}</div>`
                : ""
            }
          </div>`
            )
            .join("")}
        </div>
      </div>
    </section>`
    : "";

  const philHtml = philosophy.length
    ? `
    <section class="section">
      <div class="shell">
        <h2>Product philosophy</h2>
        <p class="section-sub">Recurring design principles. The team's taste, not its tech stack.</p>
        <ul class="philosophy-list">
          ${philosophy
            .map(
              (item) => `
          <li>
            <strong>${escapeHtml(item.name)}</strong> — ${escapeHtml(item.statement)}
            ${
              item.evidence_cite?.length
                ? `<div class="citations">${renderCitations(item.evidence_cite, repoPath)}</div>`
                : ""
            }
          </li>`
            )
            .join("")}
        </ul>
      </div>
    </section>`
    : "";

  const nonGoalsHtml = nonGoals.length
    ? `
    <section class="section">
      <div class="shell">
        <h2>Non-goals</h2>
        <p class="section-sub">What the team explicitly chose NOT to do.</p>
        <ul class="nongoal-list">
          ${nonGoals
            .map(
              (item) => `
          <li>
            ${escapeHtml(item.statement)}
            ${
              item.evidence_cite?.length
                ? `<div class="citations">${renderCitations(item.evidence_cite, repoPath)}</div>`
                : ""
            }
          </li>`
            )
            .join("")}
        </ul>
      </div>
    </section>`
    : "";

  // Code map — files sorted by principle coverage, each annotated with
  // its lenses + principle IDs. Filterable by lens via the chips above.
  const codeMapRowsHtml = codeMap.files
    .slice(0, 60)
    .map((entry) => {
      const lensTags = entry.lenses
        .map(
          (slug) => `<span class="lens-tag" data-lens="${escapeHtml(slug)}">${escapeHtml(lensBySlug.get(slug)?.name || slug)}</span>`
        )
        .join("");
      const principleTags = entry.principles
        .map(
          (id) => `<a class="principle-tag" href="#p-${escapeHtml(id)}" data-principle="${escapeHtml(id)}">${escapeHtml(id)}</a>`
        )
        .join("");
      const abs = path.resolve(repoPath, entry.file);
      return `
      <tr class="codemap-row" data-lenses="${escapeHtml(entry.lenses.join(","))}">
        <td><a class="cite" href="vscode://file/${escapeHtml(abs)}">${escapeHtml(entry.file)}</a></td>
        <td class="lens-cell">${lensTags}</td>
        <td class="principle-cell">${principleTags}</td>
      </tr>`;
    })
    .join("");

  const lensesAccordionHtml = lenses
    .map((lens) => {
      const lensPrinciples = principlesByLens.get(lens.slug) || [];
      if (lensPrinciples.length === 0) return "";
      const itemsHtml = lensPrinciples
        .map((p) => {
          const sStat = statSummary(stats, p.id);
          const hStat = healthSummary(health, p.id);
          const polarityBadge =
            p.polarity === "do"
              ? `<span class="badge badge-do">DO</span>`
              : `<span class="badge badge-dont">DON'T</span>`;
          const confidenceBadge = `<span class="badge ${severityClass(p.confidence)}">${escapeHtml(p.confidence || "medium")}</span>`;
          const confirmedBadge = p.confirmed_by_interview
            ? `<span class="badge badge-confirmed">confirmed</span>`
            : "";
          const staleBadge = hStat?.is_stale
            ? `<span class="badge badge-stale" title="${escapeHtml(hStat.stale_cites)}/${escapeHtml(hStat.total_cites)} citations missing">stale</span>`
            : "";
          const statsLine = sStat
            ? `<div class="stats-line">Seen <strong>${sStat.total}</strong> · accepted <strong>${sStat.accepted}</strong> · edited <strong>${sStat.edited}</strong> · skipped <strong>${sStat.skipped}</strong></div>`
            : "";
          return `
          <details id="p-${escapeHtml(p.id)}" class="principle" data-polarity="${escapeHtml(p.polarity)}" data-confidence="${escapeHtml(p.confidence || "medium")}">
            <summary>
              <span class="badges">${polarityBadge}${confidenceBadge}${confirmedBadge}${staleBadge}</span>
              <span class="rule">${escapeHtml(p.rule)}</span>
            </summary>
            <div class="principle-body">
              ${p.rationale ? `<p class="rationale">${escapeHtml(p.rationale)}</p>` : ""}
              ${
                p.examples_to_follow?.length
                  ? `<div class="example-block"><div class="example-label">Team examples to follow</div><div class="citations">${renderCitations(p.examples_to_follow, repoPath)}</div></div>`
                  : ""
              }
              ${
                p.evidence_cite?.length
                  ? `<div class="example-block"><div class="example-label">Evidence</div><div class="citations">${renderCitations(p.evidence_cite, repoPath)}</div></div>`
                  : ""
              }
              ${statsLine}
            </div>
          </details>`;
        })
        .join("");
      return `
        <section class="lens-block" data-lens="${escapeHtml(lens.slug)}">
          <header class="lens-header">
            <h3>${escapeHtml(lens.name)} <span class="lens-slug">${escapeHtml(lens.slug)}</span></h3>
            <p class="lens-rationale">${escapeHtml(lens.rationale || "")}</p>
          </header>
          ${itemsHtml}
        </section>`;
    })
    .join("");

  const healthHtml = health
    ? `
    <section class="section health-section">
      <h2>Health</h2>
      <div class="health-stats">
        <div class="health-stat ${staleCitations > 0 ? "alert" : ""}">
          <div class="health-num">${totalCitations - staleCitations}/${totalCitations}</div>
          <div class="health-label">live citations</div>
        </div>
        <div class="health-stat ${staleCitations > 0 ? "alert" : ""}">
          <div class="health-num">${health.stale_principle_count || 0}/${health.total_principles || principles.length}</div>
          <div class="health-label">principles with stale cites</div>
        </div>
      </div>
      ${
        staleCitations > 0
          ? `<p class="health-action">Run <code>adr principles refresh</code> to repair drifted citations.</p>`
          : `<p class="health-action">All citations live — principles are in sync with the codebase.</p>`
      }
    </section>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(identity ? identity.split(".")[0] : "Team principles")} — Principles report</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --fg: #e6edf3;
      --muted: #9198a1;
      --bg: #0d1117;
      --bg-alt: #161b22;
      --bg-elev: #1d2025;
      --border: #30363d;
      --border-strong: #484f58;
      --primary: #facc15;
      --primary-fg: #0d1117;
      --accent: #3aada4;
      --do: #3fb950;
      --dont: #f85149;
      --warn: #d29922;
      --radius: 8px;
    }
    * { box-sizing: border-box; }
    html {
      scroll-behavior: smooth;
      /* leave room for the sticky filter bar so anchor links (jump-
         to-principle from the code map) don't land under it */
      scroll-padding-top: 180px;
    }
    body {
      margin: 0; padding: 0;
      font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    code, .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .shell { max-width: 1200px; margin: 0 auto; padding: 0 24px; }

    .hero {
      padding: 56px 0 24px;
      background:
        radial-gradient(circle at 82% 8%, rgba(250, 204, 21, 0.10), transparent 28rem),
        radial-gradient(circle at 12% 38%, rgba(58, 173, 164, 0.08), transparent 24rem);
      border-bottom: 1px solid var(--border);
    }
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px;
      border: 1px solid var(--primary);
      color: var(--primary);
      border-radius: 999px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 16px;
    }
    h1 {
      font-size: clamp(28px, 4vw, 44px);
      font-weight: 900;
      letter-spacing: -0.02em;
      line-height: 1.1;
      margin: 0 0 16px;
      max-width: 920px;
    }
    .identity {
      font-size: 18px;
      color: rgba(230, 237, 243, 0.92);
      max-width: 760px;
      margin: 0 0 24px;
    }
    .hero-meta {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--muted);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-top: 8px;
    }

    .part-divider {
      padding: 48px 0 0;
    }
    .part-divider .eyebrow {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--primary);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .part-title {
      font-size: clamp(22px, 2.6vw, 28px);
      font-weight: 800;
      margin: 0 0 6px;
      letter-spacing: -0.015em;
    }

    .filter-bar {
      position: sticky; top: 0; z-index: 10;
      background: rgba(13, 17, 23, 0.92);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border);
      padding: 10px 0;
      margin-top: 20px;
    }
    .filter-bar-inner {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      align-items: center;
    }
    .filter-group {
      display: flex; flex-wrap: nowrap; gap: 4px; align-items: center;
    }
    .filter-bar-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-right: 4px;
    }
    .chip {
      background: var(--bg-alt);
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 5px 11px;
      border-radius: 999px;
      font-size: 12px;
      cursor: pointer;
      transition: all 160ms ease;
      font-family: inherit;
    }
    .chip:hover { border-color: var(--primary); }
    .chip.active { background: var(--primary); color: var(--primary-fg); border-color: var(--primary); }
    .search-input {
      flex: 1 1 180px;
      max-width: 260px;
      background: var(--bg-alt);
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 5px 11px;
      border-radius: 999px;
      font-family: inherit;
      font-size: 12px;
    }
    .search-input:focus { outline: none; border-color: var(--primary); }
    .filter-lens-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
      margin-top: 8px;
    }

    .view-toggle {
      margin-left: auto;
      display: flex;
      background: var(--bg-alt);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 3px;
    }
    .view-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      padding: 4px 14px;
      border-radius: 999px;
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
      transition: all 160ms ease;
    }
    .view-btn:hover { color: var(--fg); }
    .view-btn.active { background: var(--primary); color: var(--primary-fg); }

    .section { padding: 36px 0; }
    .section + .section { padding-top: 12px; }
    .section.section-bordered { border-bottom: 1px solid var(--border); }
    h2 { font-size: 22px; font-weight: 800; margin: 0 0 6px; letter-spacing: -0.01em; }
    .section-sub { color: var(--muted); margin: 0 0 20px; }

    .card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }
    .card {
      background: var(--bg-alt);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px 20px;
    }
    .card h3 { font-size: 15px; font-weight: 700; margin: 0 0 8px; color: var(--primary); }
    .card p { font-size: 14px; color: rgba(230, 237, 243, 0.9); margin: 0 0 8px; }

    .philosophy-list, .nongoal-list { list-style: none; padding: 0; margin: 0; }
    .philosophy-list li, .nongoal-list li {
      padding: 12px 16px;
      background: var(--bg-alt);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 8px;
    }
    .nongoal-list li::before { content: "✕  "; color: var(--dont); font-weight: 700; }

    .citations {
      display: flex; flex-wrap: wrap; gap: 6px;
      margin-top: 8px;
    }
    .cite {
      display: inline-block;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--accent);
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 6px;
    }
    .cite:hover { border-color: var(--accent); text-decoration: none; }

    .codemap-wrapper { overflow-x: auto; }
    table.codemap { width: 100%; border-collapse: collapse; font-size: 13px; }
    table.codemap th, table.codemap td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    table.codemap th {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 600;
      background: var(--bg-alt);
    }
    .codemap-row.hidden { display: none; }
    .lens-tag {
      display: inline-block;
      background: var(--bg-elev);
      border: 1px solid var(--border);
      color: var(--accent);
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      margin: 1px;
      font-family: 'JetBrains Mono', monospace;
    }
    .principle-tag {
      display: inline-block;
      font-size: 11px;
      color: var(--primary);
      background: rgba(250, 204, 21, 0.10);
      border: 1px solid rgba(250, 204, 21, 0.3);
      border-radius: 4px;
      padding: 2px 6px;
      margin: 1px;
      font-family: 'JetBrains Mono', monospace;
    }

    .lens-block { margin-bottom: 28px; }
    .lens-block.hidden { display: none; }
    .lens-header { padding: 12px 0; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
    .lens-header h3 { font-size: 17px; font-weight: 700; margin: 0 0 4px; }
    .lens-slug {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--muted);
      margin-left: 8px;
      font-weight: 400;
    }
    .lens-rationale { color: var(--muted); font-size: 13px; margin: 0; }

    .principle {
      background: var(--bg-alt);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 8px;
    }
    .principle.hidden { display: none; }
    .principle summary {
      cursor: pointer;
      padding: 12px 16px;
      list-style: none;
      display: flex; gap: 10px; align-items: flex-start;
    }
    .principle summary::-webkit-details-marker { display: none; }
    .principle summary::after {
      content: "›";
      margin-left: auto;
      font-size: 18px;
      color: var(--muted);
      transition: transform 160ms ease;
      flex-shrink: 0;
    }
    .principle[open] summary::after { transform: rotate(90deg); }
    .principle .badges { display: flex; gap: 4px; flex-wrap: wrap; flex-shrink: 0; }
    .principle .rule { flex: 1; font-weight: 500; line-height: 1.45; }

    .principle-body { padding: 0 16px 16px; border-top: 1px solid var(--border); }
    .principle-body .rationale { color: rgba(230, 237, 243, 0.85); margin: 12px 0; font-size: 14px; }
    .example-block { margin-top: 12px; }
    .example-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
    }
    .stats-line { font-size: 12px; color: var(--muted); margin-top: 12px; padding-top: 8px; border-top: 1px dashed var(--border); }

    .badge {
      display: inline-flex; align-items: center;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }
    .badge-do { background: rgba(63, 185, 80, 0.15); color: var(--do); }
    .badge-dont { background: rgba(248, 81, 73, 0.15); color: var(--dont); }
    .conf-high { background: rgba(63, 185, 80, 0.10); color: var(--do); }
    .conf-medium { background: rgba(210, 153, 34, 0.15); color: var(--warn); }
    .conf-low { background: rgba(248, 81, 73, 0.10); color: var(--dont); }
    .badge-confirmed { background: rgba(58, 173, 164, 0.15); color: var(--accent); }
    .badge-stale { background: rgba(248, 81, 73, 0.15); color: var(--dont); }

    .empty-state {
      padding: 32px;
      text-align: center;
      background: var(--bg-alt);
      border: 1px dashed var(--border-strong);
      border-radius: var(--radius);
      color: var(--muted);
      font-size: 14px;
    }
    .link-button {
      background: none;
      border: none;
      color: var(--primary);
      cursor: pointer;
      font-family: inherit;
      font-size: inherit;
      text-decoration: underline;
      padding: 0;
    }
    .lens-tag { cursor: pointer; }
    .lens-tag:hover { border-color: var(--accent); }

    .health-section .health-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      max-width: 720px;
    }
    .health-stat {
      background: var(--bg-alt);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 18px;
    }
    .health-stat.alert { border-color: var(--dont); }
    .health-num { font-size: 26px; font-weight: 800; }
    .health-stat.alert .health-num { color: var(--dont); }
    .health-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
    .health-action { margin-top: 14px; color: var(--muted); font-size: 13px; }

    footer {
      padding: 32px 0;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 13px;
      text-align: center;
    }
  </style>
</head>
<body>

  <div class="hero">
    <div class="shell">
      <div class="pill">Beevibe AI CTO · Principles report</div>
      <h1>${escapeHtml(identity || "Team principles")}</h1>
      <div class="hero-meta">
        ${lenses.length} lens${lenses.length === 1 ? "" : "es"}
        · ${principles.length} principle${principles.length === 1 ? "" : "s"}
        · ${archIntent.length} architectural decision${archIntent.length === 1 ? "" : "s"}
        · ${nonGoals.length} non-goal${nonGoals.length === 1 ? "" : "s"}
      </div>
    </div>
  </div>

  <!-- PART 1 — THE PORTRAIT (read-only, narrative) -->

  ${archHtml}
  ${philHtml}
  ${nonGoalsHtml}

  <!-- PART 2 — THE EXPLORER (filter chips apply from here down) -->

  <div class="part-divider">
    <div class="shell">
      <div class="eyebrow">Part 2 · the explorer</div>
      <h2 class="part-title">${principles.length} code-level rules across ${lenses.length} lenses</h2>
      <p class="section-sub">Grounded in your team's own <code>file:line</code> citations. Filter, search, or switch the view.</p>
    </div>
  </div>

  <div class="filter-bar">
    <div class="shell filter-bar-inner">
      <div class="filter-group">
        <span class="filter-bar-label">Polarity</span>
        <button class="chip polarity-chip active" data-polarity="all">All</button>
        <button class="chip polarity-chip" data-polarity="do">DO</button>
        <button class="chip polarity-chip" data-polarity="dont">DON'T</button>
      </div>
      <div class="filter-group">
        <span class="filter-bar-label">Confidence</span>
        <button class="chip confidence-chip active" data-confidence="all">All</button>
        <button class="chip confidence-chip" data-confidence="high">High</button>
        <button class="chip confidence-chip" data-confidence="medium">Med</button>
        <button class="chip confidence-chip" data-confidence="low">Low</button>
      </div>
      <input type="text" id="search" class="search-input" placeholder="search rules…" />
      <div class="view-toggle">
        <button class="view-btn active" data-view="by-lens">By lens</button>
        <button class="view-btn" data-view="by-file">By file</button>
      </div>
    </div>
    <div class="shell filter-lens-row">
      <span class="filter-bar-label">Lens</span>
      <button class="chip lens-chip active" data-lens="all">All</button>
      ${lensChipsHtml}
    </div>
  </div>

  <section class="section" id="view-by-lens">
    <div class="shell">
      <div id="empty-state" class="empty-state hidden">No principles match the current filters. <button class="link-button" id="reset-filters">Reset filters</button></div>
      ${lensesAccordionHtml}
    </div>
  </section>

  <section class="section hidden" id="view-by-file">
    <div class="shell">
      <p class="section-sub">Files ranked by how many principles cite them. Click a file path to open in your editor; click a lens tag to filter to it; click a principle id to jump to its rule.</p>
      <div class="codemap-wrapper">
        <table class="codemap">
          <thead>
            <tr><th>File</th><th>Lenses</th><th>Principles</th></tr>
          </thead>
          <tbody>
            ${codeMapRowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  </section>

  ${healthHtml ? `<div class="shell">${healthHtml}</div>` : ""}

  <footer>
    Generated by <a href="https://beevibe.ai/cto/">Beevibe AI CTO</a> · <code>adr principles init</code> ·
    re-run to refresh · <a href="https://github.com/beevibe-ai/architecture-deep-research">source</a>
  </footer>

  <script>
    (function () {
      // All four filters are independent and AND-ed together. Empty
      // state (all/all/all + empty q) shows everything.
      const state = { polarity: "all", confidence: "all", lens: "all", q: "" };

      function bindChipGroup(selector, key, onChange) {
        document.querySelectorAll(selector).forEach((btn) => {
          btn.addEventListener("click", () => {
            document.querySelectorAll(selector).forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            state[key] = btn.dataset[key];
            onChange();
          });
        });
      }

      function applyFilters() {
        const principles = document.querySelectorAll(".principle");
        const blocks = document.querySelectorAll(".lens-block");
        const rows = document.querySelectorAll(".codemap-row");
        const q = state.q.toLowerCase().trim();
        let visibleCount = 0;

        principles.forEach((el) => {
          const polarity = el.dataset.polarity;
          const confidence = el.dataset.confidence;
          const lensSlug = el.closest(".lens-block")?.dataset.lens || "";
          const text = el.textContent.toLowerCase();
          let show = true;
          if (state.polarity !== "all" && polarity !== state.polarity) show = false;
          if (state.confidence !== "all" && confidence !== state.confidence) show = false;
          if (state.lens !== "all" && lensSlug !== state.lens) show = false;
          if (q && !text.includes(q)) show = false;
          el.classList.toggle("hidden", !show);
          if (show) visibleCount += 1;
        });

        blocks.forEach((block) => {
          const lens = block.dataset.lens;
          const lensMatch = state.lens === "all" || lens === state.lens;
          const anyVisible = !!block.querySelector(".principle:not(.hidden)");
          block.classList.toggle("hidden", !lensMatch || !anyVisible);
        });

        rows.forEach((row) => {
          const lenses = (row.dataset.lenses || "").split(",");
          const lensMatch = state.lens === "all" || lenses.includes(state.lens);
          const text = row.textContent.toLowerCase();
          let show = lensMatch;
          if (show && q) show = text.includes(q);
          row.classList.toggle("hidden", !show);
        });

        // Empty-state surface so the user sees "no matches" instead of a
        // silent blank screen when filters exclude everything.
        const emptyState = document.getElementById("empty-state");
        if (emptyState) emptyState.classList.toggle("hidden", visibleCount > 0);
      }

      bindChipGroup(".polarity-chip", "polarity", applyFilters);
      bindChipGroup(".confidence-chip", "confidence", applyFilters);
      bindChipGroup(".lens-chip", "lens", applyFilters);

      document.getElementById("search").addEventListener("input", (e) => {
        state.q = e.target.value;
        applyFilters();
      });

      // View toggle — by lens (accordion) vs by file (code map). Only
      // one view shows at a time so the eye has one place to look.
      const viewByLens = document.getElementById("view-by-lens");
      const viewByFile = document.getElementById("view-by-file");
      document.querySelectorAll(".view-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          document.querySelectorAll(".view-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          const v = btn.dataset.view;
          viewByLens.classList.toggle("hidden", v !== "by-lens");
          viewByFile.classList.toggle("hidden", v !== "by-file");
        });
      });

      // Reset filters
      document.getElementById("reset-filters")?.addEventListener("click", () => {
        state.polarity = "all";
        state.confidence = "all";
        state.lens = "all";
        state.q = "";
        document.querySelectorAll(".polarity-chip").forEach((c) => c.classList.toggle("active", c.dataset.polarity === "all"));
        document.querySelectorAll(".confidence-chip").forEach((c) => c.classList.toggle("active", c.dataset.confidence === "all"));
        document.querySelectorAll(".lens-chip").forEach((c) => c.classList.toggle("active", c.dataset.lens === "all"));
        document.getElementById("search").value = "";
        applyFilters();
      });

      // Principle-tag in code map → scroll + expand
      document.querySelectorAll(".principle-tag").forEach((tag) => {
        tag.addEventListener("click", () => {
          const id = tag.dataset.principle;
          const target = document.getElementById("p-" + id);
          if (target) {
            target.setAttribute("open", "open");
            setTimeout(() => target.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
          }
        });
      });

      // Lens-tag in code map → set the lens filter to that lens
      document.querySelectorAll(".lens-tag").forEach((tag) => {
        tag.addEventListener("click", () => {
          const slug = tag.dataset.lens;
          if (!slug) return;
          const chip = document.querySelector('.lens-chip[data-lens="' + slug + '"]');
          if (chip) chip.click();
        });
      });
    })();
  </script>
</body>
</html>
`;
}

async function renderPrinciplesHtml({ outDir }) {
  const principlesPath = path.join(outDir, "principles.json");
  const healthPath = path.join(outDir, "principles-health.json");
  const statsPath = path.join(outDir, "principle-stats.json");
  const artifact = JSON.parse(await readFile(principlesPath, "utf8"));
  const health = await loadOptional(healthPath);
  const stats = await loadOptional(statsPath);
  const repoPath = artifact?.source?.repo_path || outDir;
  const html = renderPrinciplesHtmlString({ artifact, stats, health, repoPath });
  const htmlPath = path.join(outDir, "principles.html");
  await writeFile(htmlPath, html);
  return htmlPath;
}

export { renderPrinciplesHtml, renderPrinciplesHtmlString };
