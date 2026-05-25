import { callLlmJson } from "../kernel.mjs";

function summarizeScanForExtraction(scan, sourceSample) {
  return {
    repo_path: scan.repo_path,
    top_level: scan.top_level,
    tree_excerpt: scan.tree.slice(0, 120),
    docs: scan.docs.map((doc) => ({
      path: doc.path,
      kind: doc.kind || "doc",
      content: doc.content
    })),
    manifests: scan.manifests.map((m) => ({
      path: m.path,
      kind: m.kind,
      content: m.content
    })),
    deploy_configs: scan.deploy_configs.map((c) => ({
      path: c.path,
      platform: c.platform,
      content: c.content
    })),
    observability_signals: scan.observability_signals,
    todo_hits: scan.todo_hits,
    codeowners_path: scan.codeowners?.path || null,
    git_signals: scan.git_signals
      ? {
          contributors_shortlog: scan.git_signals.contributors_shortlog,
          package_json_history_excerpt:
            scan.git_signals.package_json_history_excerpt
        }
      : null,
    source_samples: sourceSample.samples
  };
}

function normalizeCite(value) {
  if (Array.isArray(value)) {
    return value.map(String).filter((cite) => cite.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

async function extractPatternsForLens(scan, sourceSample, lens) {
  const raw = await callLlmJson({
    label: "principles_pattern_extractor",
    system: [
      "You are the per-lens pattern extractor for `adr principles init`.",
      "",
      `You have been given the lens: "${lens.name}" (slug: ${lens.slug}).`,
      `Rationale: ${lens.rationale}`,
      "",
      "Look at the repo scan AND source_samples ONLY through this lens. Surface:",
      "",
      "1. positive_patterns — conventions the team appears to already",
      "   follow under this lens. Each must cite specific files (and lines",
      "   when available) from the scan. The rule should be actionable in",
      "   a PR review — 'state lives in stores under /stores' is good,",
      "   'good architecture' is not.",
      "",
      "2. antipatterns — things the team has rejected, deprecated, or",
      "   warned against under this lens. Pull signals from TODO/FIXME",
      "   comments, 'rejected alternatives' sections, removed dependencies",
      "   in git history, eslint disables, deprecated-suffixed files. If",
      "   nothing rises under this lens, return an empty list.",
      "",
      "3. ambiguities — places where the scan shows conflicting evidence",
      "   under this lens. Example: 'I see Zustand stores AND useState in",
      "   components — is local state allowed for derived UI?'. These",
      "   become interview questions downstream. Each ambiguity must",
      "   include both sides of the conflict with file:line.",
      "",
      "Rules:",
      "- Stay strictly inside the lens. Do not surface patterns that",
      "  belong to other lenses.",
      "- Up to 6 positive_patterns, 4 antipatterns, 4 ambiguities per lens.",
      "- Every item needs at least one citation pointing at a real path",
      "  from source_samples or scan docs. NO INVENTED PATHS. Cite",
      "  `source_samples[].path` exactly as written.",
      "- CITE EXACT LINES, NOT RANGES. `src/kernel.mjs:42` is good;",
      "  `src/kernel.mjs:10-110` is bad — the range tells a reviewer",
      "  nothing about WHERE in the file the pattern is. Find the single",
      "  line where the pattern is most visible (the declaration, the",
      "  signature, the call site) and cite that. If a pattern truly",
      "  spans many lines, pick the line that anchors it.",
      "- Rules must be specific and reviewable, not vague aspirations.",
      "- A rule a PR reviewer can act on (`X must live in Y, not Z`)",
      "  beats a product description (`the system handles X`).",
      "- If the lens turns out to have no real signal in this repo,",
      "  return empty arrays. Do not pad.",
      "",
      "ANTIPATTERN SIGNALS to look for harder (most teams have some):",
      "- todo_hits / FIXME / XXX / DEPRECATED comments naming things to",
      "  remove or fix",
      "- git_signals.package_json_history_excerpt — dependencies removed",
      "  over time. The team chose to migrate away.",
      "- 'Rejected alternatives', 'Non-goals', 'Deprecated', 'Removed'",
      "  sections in docs",
      "- filename/dir suffixes: -deprecated, -legacy, -old, .deprecated",
      "- eslint disables in a config (signals the team rejected the rule)",
      "- past ADRs (docs/adr/) listing rejected options",
      "If you find zero antipatterns, double-check these signals before",
      "returning an empty list.",
      "",
      "Output JSON:",
      "{",
      "  positive_patterns: [{ name, rule, evidence_cite: [string], why? }],",
      "  antipatterns: [{ name, rule, evidence_cite: [string], why?, alternative? }],",
      "  ambiguities: [{",
      "    description: string,",
      "    conflicting_evidence: [{ cite: string, observation: string }]",
      "  }]",
      "}"
    ].join("\n"),
    user: JSON.stringify({
      lens,
      scan: summarizeScanForExtraction(scan, sourceSample)
    })
  });

  const positive = Array.isArray(raw.positive_patterns)
    ? raw.positive_patterns
    : [];
  const anti = Array.isArray(raw.antipatterns) ? raw.antipatterns : [];
  const ambiguities = Array.isArray(raw.ambiguities) ? raw.ambiguities : [];

  return {
    lens_slug: lens.slug,
    positive_patterns: positive
      .filter(
        (p) => p && typeof p === "object" && typeof p.name === "string"
      )
      .map((p) => ({
        name: String(p.name).trim(),
        rule: typeof p.rule === "string" ? p.rule.trim() : "",
        evidence_cite: normalizeCite(p.evidence_cite),
        why: typeof p.why === "string" ? p.why.trim() : ""
      }))
      .filter((p) => p.name && p.evidence_cite.length > 0),
    antipatterns: anti
      .filter(
        (p) => p && typeof p === "object" && typeof p.name === "string"
      )
      .map((p) => ({
        name: String(p.name).trim(),
        rule: typeof p.rule === "string" ? p.rule.trim() : "",
        evidence_cite: normalizeCite(p.evidence_cite),
        why: typeof p.why === "string" ? p.why.trim() : "",
        alternative:
          typeof p.alternative === "string" ? p.alternative.trim() : ""
      }))
      .filter((p) => p.name && p.evidence_cite.length > 0),
    ambiguities: ambiguities
      .filter(
        (a) =>
          a &&
          typeof a === "object" &&
          typeof a.description === "string" &&
          a.description.trim()
      )
      .map((a) => ({
        description: a.description.trim(),
        conflicting_evidence: Array.isArray(a.conflicting_evidence)
          ? a.conflicting_evidence
              .filter(
                (c) =>
                  c &&
                  typeof c === "object" &&
                  typeof c.cite === "string" &&
                  c.cite.trim()
              )
              .map((c) => ({
                cite: c.cite.trim(),
                observation:
                  typeof c.observation === "string"
                    ? c.observation.trim()
                    : ""
              }))
          : []
      }))
  };
}

export { extractPatternsForLens };
