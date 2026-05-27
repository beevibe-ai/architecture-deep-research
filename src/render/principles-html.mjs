// Notion-style interactive principles.html report.
//
// Design: design-shotgun approved variant B (2026-05-26):
//   - Warm dark theme (#1f1f1f bg, #2d2d2d cards)
//   - Lora serif for display headings, Inter for body, JetBrains Mono
//     for code/citations
//   - Soft drop-shadow cards with confidence-colored left border
//   - 280px sidebar nav (portrait shortcuts + lenses) + single main
//     reading column (max ~1080px)
//   - Click any citation → vscode://file/<abs>:<line>
//
// Renders four blocks in order: Portrait (identity / arch intent /
// philosophy / non-goals), Code-level rules accordion, Code map
// (toggleable view), Health snapshot. All under one sticky filter
// bar (polarity / confidence / search / view toggle).

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

function buildCodeMap(artifact) {
  const fileMap = new Map();
  for (const p of artifact.principles || []) {
    const cites = [
      ...(p.evidence_cite || []),
      ...(p.examples_to_follow || [])
    ];
    for (const cite of cites) {
      const f = fileFromCite(cite);
      if (!f) continue;
      if (!fileMap.has(f)) {
        fileMap.set(f, {
          file: f,
          lenses: new Set(),
          principles: new Set()
        });
      }
      const entry = fileMap.get(f);
      entry.lenses.add(p.lens || "");
      entry.principles.add(p.id);
    }
  }
  return [...fileMap.values()]
    .map((e) => ({
      file: e.file,
      lenses: [...e.lenses],
      principles: [...e.principles]
    }))
    .sort((a, b) => b.principles.length - a.principles.length);
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
    .join("");
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
    skipped: slot.skipped || 0
  };
}

function healthFor(health, principleId) {
  if (!health?.by_principle) return null;
  return health.by_principle.find((p) => p.principle_id === principleId) || null;
}

function confidenceColor(c) {
  if (c === "high") return "#3fb950";
  if (c === "low") return "#f85149";
  return "#d29922";
}

function renderPrinciplesHtmlString({ artifact, stats, health, repoPath }) {
  const productIntent = artifact.product_intent || {};
  const identity = productIntent.identity || "Team principles";
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

  // ── sidebar nav (portrait shortcuts + lenses)
  const lensNavHtml = lenses
    .map((lens) => {
      const count = (principlesByLens.get(lens.slug) || []).length;
      return `
      <a class="nav-link" href="#lens-${escapeHtml(lens.slug)}" data-lens-anchor="${escapeHtml(lens.slug)}">
        <span class="nav-name">${escapeHtml(lens.name)}</span>
        <span class="nav-count">${count}</span>
      </a>`;
    })
    .join("");

  // ── architectural intent: each decision with a yellow left rule
  const archHtml = archIntent.length
    ? `
    <section class="portrait-block" id="architectural-intent">
      <h2 class="serif">Architectural intent</h2>
      <p class="block-sub">The foundational decisions everything else hangs off of.</p>
      ${archIntent
        .map(
          (item) => `
      <div class="arch-decision">
        <h3 class="serif">${escapeHtml(item.name)}</h3>
        ${item.why ? `<p>${escapeHtml(item.why)}</p>` : ""}
        ${
          item.evidence_cite?.length
            ? `<div class="cites-line">Anchored in ${renderCitations(item.evidence_cite, repoPath)}</div>`
            : ""
        }
      </div>`
        )
        .join("")}
    </section>`
    : "";

  // ── product philosophy: soft cards
  const philHtml = philosophy.length
    ? `
    <section class="portrait-block" id="product-philosophy">
      <h2 class="serif">Product philosophy</h2>
      <p class="block-sub">Recurring design principles — the team's taste, not its tech stack.</p>
      <div class="philosophy-stack">
        ${philosophy
          .map(
            (item) => `
        <div class="philosophy-card">
          <strong class="serif">${escapeHtml(item.name)}</strong>
          <p>${escapeHtml(item.statement)}</p>
          ${
            item.evidence_cite?.length
              ? `<div class="citations">${renderCitations(item.evidence_cite, repoPath)}</div>`
              : ""
          }
        </div>`
          )
          .join("")}
      </div>
    </section>`
    : "";

  // ── non-goals: dashed separator list with ✕
  const nonGoalsHtml = nonGoals.length
    ? `
    <section class="portrait-block" id="non-goals">
      <h2 class="serif">Non-goals</h2>
      <p class="block-sub">What the team explicitly chose NOT to do.</p>
      <div class="nongoal-list">
        ${nonGoals
          .map(
            (item) => `
        <div class="nongoal">
          <span class="nongoal-mark">✕</span>
          <div class="nongoal-body">
            ${escapeHtml(item.statement)}
            ${
              item.evidence_cite?.length
                ? `<div class="citations">${renderCitations(item.evidence_cite, repoPath)}</div>`
                : ""
            }
          </div>
        </div>`
          )
          .join("")}
      </div>
    </section>`
    : "";

  // ── per-lens rule cards (the accordion view)
  const lensSectionsHtml = lenses
    .map((lens) => {
      const items = principlesByLens.get(lens.slug) || [];
      if (items.length === 0) return "";
      const cardsHtml = items
        .map((p) => {
          const sStat = statSummary(stats, p.id);
          const hStat = healthFor(health, p.id);
          const polarity = p.polarity === "do" ? "DO" : "DON'T";
          const polarityClass = `badge-${p.polarity}`;
          const confClr = confidenceColor(p.confidence);
          const statsLine = sStat
            ? `<div class="stats-line">Seen ${sStat.total} · accepted ${sStat.accepted} · edited ${sStat.edited} · skipped ${sStat.skipped}</div>`
            : "";
          const staleBadge = hStat?.is_stale
            ? `<span class="stale-flag" title="${escapeHtml(hStat.stale_cites)}/${escapeHtml(hStat.total_cites)} citations missing">stale</span>`
            : "";
          return `
          <details id="p-${escapeHtml(p.id)}" class="rule-card" data-polarity="${escapeHtml(p.polarity)}" data-confidence="${escapeHtml(p.confidence || "medium")}" style="border-left-color: ${confClr}">
            <summary>
              <div class="rule-card-meta">
                <span class="badge ${polarityClass}">${polarity}</span>
                <span class="conf-tag" style="color: ${confClr}">${escapeHtml(p.confidence || "medium")}</span>
                ${p.confirmed_by_interview ? `<span class="confirmed-tag">confirmed</span>` : ""}
                ${staleBadge}
              </div>
              <h4 class="rule-text serif">${escapeHtml(p.rule)}</h4>
            </summary>
            <div class="rule-body">
              ${p.rationale ? `<p class="rationale">${escapeHtml(p.rationale)}</p>` : ""}
              ${
                p.examples_to_follow?.length
                  ? `<div class="example-block"><div class="example-label">Team example to follow</div><div class="citations">${renderCitations(p.examples_to_follow, repoPath)}</div></div>`
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
      <section class="lens-section" id="lens-${escapeHtml(lens.slug)}" data-lens="${escapeHtml(lens.slug)}">
        <header class="lens-section-head">
          <h3 class="serif">${escapeHtml(lens.name)}</h3>
          <p class="lens-rationale">${escapeHtml(lens.rationale || "")}</p>
        </header>
        <div class="rule-card-stack">
          ${cardsHtml}
        </div>
      </section>`;
    })
    .join("");

  // ── code map: notion-style. Soft rows, serif filename, big readable.
  const codeMapHtml = codeMap
    .slice(0, 80)
    .map((entry) => {
      const lensTags = entry.lenses
        .map((slug) => {
          const name = lensBySlug.get(slug)?.name || slug;
          return `<span class="cm-lens-tag" data-lens="${escapeHtml(slug)}">${escapeHtml(name)}</span>`;
        })
        .join("");
      const principleTags = entry.principles
        .map(
          (id) => `<a class="cm-principle-tag" href="#p-${escapeHtml(id)}" data-principle="${escapeHtml(id)}">${escapeHtml(id)}</a>`
        )
        .join("");
      const abs = path.resolve(repoPath, entry.file);
      return `
      <div class="cm-row" data-lenses="${escapeHtml(entry.lenses.join(","))}">
        <a class="cm-file serif" href="vscode://file/${escapeHtml(abs)}">${escapeHtml(entry.file)}</a>
        <div class="cm-meta">
          <div class="cm-lenses">${lensTags}</div>
          <div class="cm-principles">${principleTags}</div>
        </div>
      </div>`;
    })
    .join("");

  // ── health
  const healthHtml = health
    ? `
    <section class="portrait-block" id="health">
      <h2 class="serif">Health</h2>
      <p class="block-sub">Cite-rot check from the last <code>adr review</code> run.</p>
      <div class="health-cards">
        <div class="health-card ${staleCitations > 0 ? "alert" : "ok"}">
          <div class="health-num">${totalCitations - staleCitations}/${totalCitations}</div>
          <div class="health-label">live citations</div>
        </div>
        <div class="health-card ${(health.stale_principle_count || 0) > 0 ? "alert" : "ok"}">
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
  <title>${escapeHtml(identity.split(".")[0])} — Principles report</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Lora:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #1f1f1f;
      --bg-alt: #2a2a2a;
      --bg-card: #2d2d2d;
      --bg-elev: #353535;
      --fg: #e8e6e3;
      --muted: #a8a29e;
      --muted-2: #78716c;
      --primary: #facc15;
      --teal: #3aada4;
      --do: #3fb950;
      --dont: #f85149;
      --warn: #d29922;
      --border: #3a3a38;
      --shadow: 0 4px 16px rgba(0,0,0,0.35);
      --shadow-lg: 0 8px 28px rgba(0,0,0,0.4);
    }
    * { box-sizing: border-box; }
    html {
      scroll-behavior: smooth;
      scroll-padding-top: 100px;
    }
    body {
      margin: 0;
      font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
      background: var(--bg);
      color: var(--fg);
      font-size: 15px;
      line-height: 1.7;
      -webkit-font-smoothing: antialiased;
    }
    .serif { font-family: 'Lora', Georgia, 'Times New Roman', serif; }
    code, .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.92em; }
    a { color: var(--fg); text-decoration: none; }
    a:hover { opacity: 0.85; }
    a:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: 3px; }

    .app {
      display: grid;
      grid-template-columns: 280px 1fr;
      min-height: 100vh;
    }
    .sidebar {
      background: var(--bg-alt);
      border-right: 1px solid var(--border);
      padding: 32px 24px;
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
    }
    .sidebar::-webkit-scrollbar { width: 6px; }
    .sidebar::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    .sidebar-brand {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--primary);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin-bottom: 28px;
    }
    .sidebar h3 {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.12em;
      margin: 28px 0 8px;
      font-weight: 600;
    }
    .sidebar h3:first-of-type { margin-top: 0; }
    .nav-link {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 7px 12px;
      border-radius: 6px;
      color: var(--muted);
      font-size: 13px;
      transition: all 120ms ease;
      margin-bottom: 1px;
    }
    .nav-link:hover { background: var(--bg-card); color: var(--fg); opacity: 1; }
    .nav-link.active {
      background: var(--bg-card);
      color: var(--primary);
      border-left: 2px solid var(--primary);
      padding-left: 10px;
    }
    .nav-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 8px; }
    .nav-count {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      opacity: 0.6;
    }

    .main {
      padding: 56px 64px 80px;
      max-width: 1080px;
      min-width: 0;
    }
    h1.editorial {
      font-family: 'Lora', Georgia, serif;
      font-size: clamp(34px, 4vw, 52px);
      font-weight: 600;
      line-height: 1.15;
      letter-spacing: -0.01em;
      margin: 0 0 18px;
    }
    .meta-line {
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 48px;
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: 0.03em;
    }

    /* sticky filter bar — quiet, integrated into the main column */
    .filter-bar {
      position: sticky;
      top: 0;
      z-index: 10;
      background: rgba(31, 31, 31, 0.94);
      backdrop-filter: blur(12px);
      margin: 0 -64px 32px;
      padding: 14px 64px;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-wrap: wrap;
      gap: 8px 16px;
      align-items: center;
    }
    .filter-group { display: flex; gap: 4px; align-items: center; }
    .filter-label {
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
      padding: 4px 11px;
      border-radius: 999px;
      font-size: 12px;
      cursor: pointer;
      transition: all 120ms ease;
      font-family: inherit;
    }
    .chip:hover { border-color: var(--primary); }
    .chip.active {
      background: var(--primary);
      color: #1f1f1f;
      border-color: var(--primary);
      font-weight: 600;
    }
    .search-input {
      flex: 1 1 200px;
      max-width: 280px;
      background: var(--bg-alt);
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 5px 12px;
      border-radius: 999px;
      font-family: inherit;
      font-size: 13px;
    }
    .search-input:focus { outline: none; border-color: var(--primary); }
    .view-toggle {
      margin-left: auto;
      display: flex;
      background: var(--bg-alt);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px;
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
      transition: all 120ms ease;
    }
    .view-btn.active { background: var(--primary); color: #1f1f1f; font-weight: 600; }
    .filter-lens-row { width: 100%; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }

    /* portrait blocks */
    .portrait-block { margin-bottom: 56px; }
    .portrait-block h2 {
      font-size: 28px;
      font-weight: 600;
      margin: 0 0 6px;
      letter-spacing: -0.005em;
    }
    .block-sub {
      color: var(--muted);
      font-size: 14px;
      margin: 0 0 24px;
      font-style: italic;
    }
    .block-sub code { font-style: normal; background: var(--bg-alt); padding: 1px 6px; border-radius: 3px; color: var(--primary); }

    .arch-decision {
      border-left: 3px solid var(--primary);
      padding: 6px 0 6px 22px;
      margin-bottom: 28px;
    }
    .arch-decision:last-child { margin-bottom: 0; }
    .arch-decision h3 {
      font-size: 20px;
      font-weight: 600;
      margin: 0 0 8px;
    }
    .arch-decision p { margin: 0 0 10px; color: rgba(232, 230, 227, 0.88); }
    .cites-line { color: var(--muted); font-size: 12px; }

    .philosophy-stack { display: flex; flex-direction: column; gap: 14px; }
    .philosophy-card {
      background: var(--bg-card);
      border-radius: 10px;
      padding: 18px 22px;
      box-shadow: var(--shadow);
    }
    .philosophy-card strong {
      display: block;
      font-weight: 600;
      font-size: 17px;
      margin-bottom: 6px;
    }
    .philosophy-card p { margin: 0 0 8px; color: rgba(232, 230, 227, 0.88); }

    .nongoal-list { display: flex; flex-direction: column; }
    .nongoal {
      display: flex;
      gap: 14px;
      padding: 14px 0;
      border-top: 1px dashed var(--border);
    }
    .nongoal:first-child { border-top: none; padding-top: 4px; }
    .nongoal-mark {
      color: var(--dont);
      font-weight: 700;
      font-size: 18px;
      flex-shrink: 0;
      line-height: 1.5;
    }
    .nongoal-body { flex: 1; }

    /* citations */
    .citations { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .cite {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--warn);
      background: var(--bg-alt);
      padding: 2px 8px;
      border-radius: 4px;
      transition: all 120ms ease;
    }
    .cite:hover { background: var(--bg-elev); color: var(--primary); }

    /* lens sections + rule cards */
    .rules-divider {
      margin: 64px 0 36px;
      text-align: center;
      color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      letter-spacing: 0.2em;
      text-transform: uppercase;
    }
    .rules-divider::before, .rules-divider::after {
      content: "";
      display: inline-block;
      width: 64px;
      height: 1px;
      background: var(--border);
      vertical-align: middle;
      margin: 0 16px;
    }
    .lens-section { margin-bottom: 52px; }
    .lens-section.hidden { display: none; }
    .lens-section-head { margin-bottom: 18px; }
    .lens-section-head h3 {
      font-size: 24px;
      font-weight: 600;
      margin: 0 0 4px;
    }
    .lens-rationale { color: var(--muted); font-size: 13px; margin: 0; font-style: italic; }
    .rule-card-stack { display: flex; flex-direction: column; gap: 14px; }

    .rule-card {
      background: var(--bg-card);
      border-radius: 10px;
      border-left: 4px solid var(--warn);
      box-shadow: var(--shadow);
      overflow: hidden;
      transition: box-shadow 160ms ease;
    }
    .rule-card.hidden { display: none; }
    .rule-card:hover { box-shadow: var(--shadow-lg); }
    .rule-card summary {
      cursor: pointer;
      padding: 18px 22px;
      list-style: none;
    }
    .rule-card summary::-webkit-details-marker { display: none; }
    .rule-card-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 8px;
    }
    .badge {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .badge-do { background: rgba(63, 185, 80, 0.15); color: var(--do); }
    .badge-dont { background: rgba(248, 81, 73, 0.15); color: var(--dont); }
    .conf-tag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .confirmed-tag, .stale-flag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 4px;
      letter-spacing: 0.04em;
    }
    .confirmed-tag { background: rgba(58, 173, 164, 0.15); color: var(--teal); }
    .stale-flag { background: rgba(248, 81, 73, 0.15); color: var(--dont); }
    .rule-text {
      font-size: 17px;
      font-weight: 600;
      margin: 0;
      line-height: 1.45;
    }
    .rule-body {
      padding: 4px 22px 20px;
      border-top: 1px solid var(--border);
      margin-top: 4px;
    }
    .rationale { color: rgba(232, 230, 227, 0.85); font-size: 14px; margin: 14px 0; font-style: italic; }
    .example-block { margin-top: 14px; }
    .example-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 6px;
    }
    .stats-line {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px dashed var(--border);
      color: var(--muted);
      font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
    }

    /* code map view */
    .codemap-list { display: flex; flex-direction: column; gap: 8px; }
    .cm-row {
      background: var(--bg-card);
      border-radius: 8px;
      padding: 14px 18px;
      box-shadow: var(--shadow);
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      align-items: flex-start;
    }
    .cm-row.hidden { display: none; }
    .cm-file {
      font-size: 14px;
      font-weight: 600;
      color: var(--primary);
      word-break: break-all;
    }
    .cm-meta { display: flex; flex-direction: column; gap: 6px; }
    .cm-lenses, .cm-principles { display: flex; flex-wrap: wrap; gap: 4px; }
    .cm-lens-tag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      background: var(--bg-elev);
      color: var(--teal);
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 120ms ease;
    }
    .cm-lens-tag:hover { background: var(--teal); color: #1f1f1f; }
    .cm-principle-tag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      color: var(--warn);
      background: rgba(210, 153, 34, 0.12);
      padding: 2px 8px;
      border-radius: 4px;
      border: 1px solid rgba(210, 153, 34, 0.3);
    }
    .cm-principle-tag:hover { background: rgba(210, 153, 34, 0.25); }

    /* empty state */
    .empty-state {
      padding: 36px 24px;
      text-align: center;
      background: var(--bg-card);
      border-radius: 10px;
      color: var(--muted);
      font-size: 14px;
      font-style: italic;
    }
    .empty-state.hidden { display: none; }
    .link-button {
      background: none;
      border: none;
      color: var(--primary);
      cursor: pointer;
      font-family: inherit;
      font-size: inherit;
      text-decoration: underline;
      padding: 0;
      font-style: normal;
    }

    /* health */
    .health-cards { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
    .health-card {
      background: var(--bg-card);
      border-radius: 10px;
      padding: 18px 24px;
      box-shadow: var(--shadow);
      flex: 1 1 200px;
      border-left: 4px solid var(--do);
    }
    .health-card.alert { border-left-color: var(--dont); }
    .health-num { font-size: 28px; font-weight: 700; line-height: 1; }
    .health-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-top: 8px;
    }
    .health-action { color: var(--muted); font-size: 14px; margin-top: 14px; font-style: italic; }
    .health-action code { background: var(--bg-alt); padding: 1px 6px; border-radius: 3px; color: var(--primary); font-style: normal; }

    footer {
      margin-top: 80px;
      padding-top: 32px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 13px;
      text-align: center;
    }

    @media (max-width: 960px) {
      .app { grid-template-columns: 1fr; }
      .sidebar {
        position: static;
        height: auto;
        border-right: none;
        border-bottom: 1px solid var(--border);
      }
      .main { padding: 32px 28px 64px; }
      .filter-bar { margin: 0 -28px 28px; padding: 14px 28px; }
      h1.editorial { font-size: 32px; }
      .cm-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="sidebar-brand">Beevibe AI CTO</div>
      <h3>The portrait</h3>
      <a class="nav-link" href="#what-this-is"><span class="nav-name">What this is</span></a>
      <a class="nav-link" href="#architectural-intent"><span class="nav-name">Architectural intent</span><span class="nav-count">${archIntent.length}</span></a>
      <a class="nav-link" href="#product-philosophy"><span class="nav-name">Product philosophy</span><span class="nav-count">${philosophy.length}</span></a>
      <a class="nav-link" href="#non-goals"><span class="nav-name">Non-goals</span><span class="nav-count">${nonGoals.length}</span></a>
      <h3>Lenses</h3>
      ${lensNavHtml}
      <h3>Other</h3>
      ${health ? `<a class="nav-link" href="#health"><span class="nav-name">Health</span><span class="nav-count">${staleCitations > 0 ? "⚠" : "✓"}</span></a>` : ""}
    </aside>

    <main class="main">
      <h1 class="editorial" id="what-this-is">${escapeHtml(identity)}</h1>
      <div class="meta-line">
        ${lenses.length} lenses · ${principles.length} principles · ${archIntent.length} architectural decisions · scanned ${new Date(artifact.source.scanned_at).toLocaleDateString()}
      </div>

      ${archHtml}
      ${philHtml}
      ${nonGoalsHtml}

      <div class="rules-divider">Code-level rules</div>

      <div class="filter-bar">
        <div class="filter-group">
          <span class="filter-label">Polarity</span>
          <button class="chip polarity-chip active" data-polarity="all">All</button>
          <button class="chip polarity-chip" data-polarity="do">DO</button>
          <button class="chip polarity-chip" data-polarity="dont">DON'T</button>
        </div>
        <div class="filter-group">
          <span class="filter-label">Confidence</span>
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
        <div class="filter-lens-row">
          <span class="filter-label">Lens</span>
          <button class="chip lens-chip active" data-lens="all">All</button>
          ${lenses
            .map(
              (l) =>
                `<button class="chip lens-chip" data-lens="${escapeHtml(l.slug)}">${escapeHtml(l.name)}</button>`
            )
            .join("")}
        </div>
      </div>

      <div id="view-by-lens">
        <div id="empty-state" class="empty-state hidden">No principles match the current filters. <button class="link-button" id="reset-filters">Reset filters</button></div>
        ${lensSectionsHtml}
      </div>

      <div id="view-by-file" class="hidden">
        <div class="codemap-list">
          ${codeMapHtml}
        </div>
      </div>

      ${healthHtml}

      <footer>
        Generated by <a href="https://beevibe.ai/cto/" style="color: var(--primary);">Beevibe AI CTO</a> · <code>adr principles init</code>. Re-run to refresh.
      </footer>
    </main>
  </div>

  <script>
    (function () {
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
        const cards = document.querySelectorAll(".rule-card");
        const sections = document.querySelectorAll(".lens-section");
        const rows = document.querySelectorAll(".cm-row");
        const q = state.q.toLowerCase().trim();
        let visibleCount = 0;

        cards.forEach((el) => {
          const polarity = el.dataset.polarity;
          const confidence = el.dataset.confidence;
          const lensSlug = el.closest(".lens-section")?.dataset.lens || "";
          const text = el.textContent.toLowerCase();
          let show = true;
          if (state.polarity !== "all" && polarity !== state.polarity) show = false;
          if (state.confidence !== "all" && confidence !== state.confidence) show = false;
          if (state.lens !== "all" && lensSlug !== state.lens) show = false;
          if (q && !text.includes(q)) show = false;
          el.classList.toggle("hidden", !show);
          if (show) visibleCount += 1;
        });

        sections.forEach((sec) => {
          const lens = sec.dataset.lens;
          const lensMatch = state.lens === "all" || lens === state.lens;
          const anyVisible = !!sec.querySelector(".rule-card:not(.hidden)");
          sec.classList.toggle("hidden", !lensMatch || !anyVisible);
        });

        rows.forEach((row) => {
          const lenses = (row.dataset.lenses || "").split(",");
          const lensMatch = state.lens === "all" || lenses.includes(state.lens);
          const text = row.textContent.toLowerCase();
          let show = lensMatch;
          if (show && q) show = text.includes(q);
          row.classList.toggle("hidden", !show);
        });

        document.getElementById("empty-state")?.classList.toggle("hidden", visibleCount > 0);
      }

      bindChipGroup(".polarity-chip", "polarity", applyFilters);
      bindChipGroup(".confidence-chip", "confidence", applyFilters);
      bindChipGroup(".lens-chip", "lens", applyFilters);

      document.getElementById("search").addEventListener("input", (e) => {
        state.q = e.target.value;
        applyFilters();
      });

      // View toggle
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

      // Code-map lens-tag → filter to that lens
      document.querySelectorAll(".cm-lens-tag").forEach((tag) => {
        tag.addEventListener("click", () => {
          const slug = tag.dataset.lens;
          const chip = document.querySelector('.lens-chip[data-lens="' + slug + '"]');
          if (chip) chip.click();
        });
      });

      // Code-map principle-tag → switch to by-lens, expand, scroll
      document.querySelectorAll(".cm-principle-tag").forEach((tag) => {
        tag.addEventListener("click", (e) => {
          e.preventDefault();
          const id = tag.dataset.principle;
          document.querySelector('.view-btn[data-view="by-lens"]')?.click();
          setTimeout(() => {
            const target = document.getElementById("p-" + id);
            if (target) {
              target.setAttribute("open", "open");
              target.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }, 50);
        });
      });

      // Scroll-spy for sidebar nav
      const sidebarLinks = document.querySelectorAll(".sidebar .nav-link[href^='#']");
      const idToLink = new Map();
      sidebarLinks.forEach((a) => {
        const id = a.getAttribute("href").slice(1);
        if (id) idToLink.set(id, a);
      });
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const id = entry.target.id;
            if (!id) return;
            const link = idToLink.get(id);
            if (!link) return;
            if (entry.isIntersecting) {
              sidebarLinks.forEach((l) => l.classList.remove("active"));
              link.classList.add("active");
            }
          });
        },
        { rootMargin: "-30% 0px -60% 0px", threshold: 0 }
      );
      document
        .querySelectorAll("#what-this-is, #architectural-intent, #product-philosophy, #non-goals, .lens-section, #health")
        .forEach((el) => observer.observe(el));

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
