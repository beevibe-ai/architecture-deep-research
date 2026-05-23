import { callLlmJson } from "../kernel.mjs";

function summarizeScanForLlm(scan) {
  // The LLM gets a structured digest, not the raw scan. We keep file:line
  // citations intact so the model can reuse them in evidence_cite.
  return {
    repo_path: scan.repo_path,
    top_level: scan.top_level,
    tree_excerpt: scan.tree.slice(0, 80),
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
          first_commit_at: scan.git_signals.first_commit_at,
          last_commit_at: scan.git_signals.last_commit_at,
          branch: scan.git_signals.branch,
          contributors_shortlog: scan.git_signals.contributors_shortlog,
          package_json_history_excerpt:
            scan.git_signals.package_json_history_excerpt
        }
      : null
  };
}

function normalizeCite(value) {
  if (Array.isArray(value)) {
    return value.map(String).filter((cite) => cite.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

async function extractPrinciples(scan, { decision, issueBody } = {}) {
  const raw = await callLlmJson({
    label: "discover_principle_extractor",
    system: [
      "You are the discovered-principles extractor for Architecture Deep Research.",
      "Read the structured repo scan below and identify two lists:",
      "- patterns: technical or architectural conventions this team appears to already follow,",
      "  cited to specific file paths (and optionally :line where the scan provides them).",
      "- antipatterns: things this team has explicitly rejected, deprecated, or warned against,",
      "  cited to the same file:line evidence.",
      "",
      "Rules:",
      "- Only list patterns or anti-patterns that the scan evidence actually supports.",
      "- Each item must have at least one citation pointing at a real path from the scan.",
      "- Do not invent file paths. Use the paths exactly as they appear in the scan.",
      "- Prefer specific names (e.g. 'monorepo_with_packages_layout') over vague ones",
      "  (e.g. 'good_code_organization').",
      "- Up to 12 patterns and 8 antipatterns. Quality over quantity.",
      "",
      "Optional architecture_family field:",
      "- If a pattern or anti-pattern clearly maps to an architecture family the deep-research",
      "  decision will consider (e.g. 'postgres_centric_storage', 'kafka_event_bus',",
      "  'graphql_federation', 'serverless_functions'), set architecture_family to a stable",
      "  slug for that family. The kernel uses this to flow the discovered item into the",
      "  evidence pool as a private_corpus claim about that family — positive for patterns,",
      "  rejecting for antipatterns.",
      "- Omit architecture_family for project-internal patterns that do not map to a named",
      "  architecture family (e.g. 'monorepo_layout', 'esm_only', 'tap-tested').",
      "",
      "Output JSON with:",
      "- patterns: [{ name: string, description: string, evidence_cite: [string], category?: string, architecture_family?: string }]",
      "- antipatterns: [{ name: string, reason: string, evidence_cite: [string], category?: string, architecture_family?: string }]"
    ].join("\n"),
    user: JSON.stringify({
      decision: decision || null,
      issue_body: issueBody || null,
      scan: summarizeScanForLlm(scan)
    })
  });

  const patterns = Array.isArray(raw.patterns) ? raw.patterns : [];
  const antipatterns = Array.isArray(raw.antipatterns) ? raw.antipatterns : [];

  return {
    patterns: patterns
      .filter((p) => p && typeof p === "object" && typeof p.name === "string" && p.name.trim())
      .map((p) => ({
        name: String(p.name).trim(),
        description: typeof p.description === "string" ? p.description.trim() : "",
        evidence_cite: normalizeCite(p.evidence_cite),
        ...(p.category ? { category: String(p.category) } : {}),
        ...(typeof p.architecture_family === "string" && p.architecture_family.trim()
          ? { architecture_family: p.architecture_family.trim() }
          : {})
      }))
      .filter((p) => p.evidence_cite.length > 0),
    antipatterns: antipatterns
      .filter((p) => p && typeof p === "object" && typeof p.name === "string" && p.name.trim())
      .map((p) => ({
        name: String(p.name).trim(),
        reason: typeof p.reason === "string" ? p.reason.trim() : "",
        evidence_cite: normalizeCite(p.evidence_cite),
        ...(p.category ? { category: String(p.category) } : {}),
        ...(typeof p.architecture_family === "string" && p.architecture_family.trim()
          ? { architecture_family: p.architecture_family.trim() }
          : {})
      }))
      .filter((p) => p.evidence_cite.length > 0)
  };
}

export { extractPrinciples };
