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
      "- antipatterns: things this team has rejected, deprecated, migrated away from,",
      "  warned against, or that the scan surfaces as documented bad practice.",
      "",
      "ANTIPATTERN SIGNALS — the scan surfaces several. Use them all, not just",
      "the obvious \"explicitly rejected\" docs. An empty antipatterns list is",
      "rarely correct for a real repo:",
      "  - todo_hits: TODO / FIXME / XXX comments. If a comment names a thing",
      "    the team plans to remove (\"TODO: drop kafka\", \"FIXME: this leaks\"),",
      "    that IS an anti-pattern with file:line citation.",
      "  - git_signals.package_json_history_excerpt: dependencies removed from",
      "    package.json over time. The team chose to migrate away — surface the",
      "    removed dep as an anti-pattern citing the git history excerpt path.",
      "  - docs that explicitly list \"Rejected alternatives\", \"Non-goals\",",
      "    \"Deprecated\", or \"Removed\" sections in ARCHITECTURE.md, README.md,",
      "    CONTRIBUTING.md, or docs/adr/*.",
      "  - filenames or directories with -deprecated, -legacy, -old, .deprecated suffixes.",
      "  - eslint / tsconfig disables for specific rules (signals the team",
      "    rejected the convention that rule enforces).",
      "",
      "If you find zero antipatterns in a real repo, double-check todo_hits and",
      "the package.json history excerpt before returning an empty list. \"None\"",
      "is a valid answer only when none of these signals are present.",
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
      "Optional opposes_families field (patterns AND antipatterns):",
      "- List 1-4 architecture_family slugs that this pattern would conflict with if the",
      "  deep-research decision picked one of them. The kernel emits private_corpus",
      "  opposing claims against each, so the matrix sees \"team already uses pgvector\"",
      "  as opposing 'pinecone' and 'weaviate', not just supporting 'pgvector'.",
      "  Examples:",
      "    pattern 'shared_postgres_with_pgvector' → opposes_families: ['pinecone','weaviate','external_vector_db']",
      "    pattern 'monolith_on_railway'           → opposes_families: ['microservices','service_mesh']",
      "    pattern 'fly_io_for_deploy'             → opposes_families: ['vercel_serverless','aws_lambda']",
      "  Only list families that are GENUINE alternatives in the same decision space.",
      "  Do not invent slugs the deep-research run wouldn't recognize. Omit when unsure.",
      "",
      "Output JSON with:",
      "- patterns: [{ name: string, description: string, evidence_cite: [string], category?: string, architecture_family?: string, opposes_families?: [string] }]",
      "- antipatterns: [{ name: string, reason: string, evidence_cite: [string], category?: string, architecture_family?: string, opposes_families?: [string] }]"
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
          : {}),
        ...(Array.isArray(p.opposes_families) && p.opposes_families.length > 0
          ? {
              opposes_families: p.opposes_families
                .filter((s) => typeof s === "string" && s.trim().length > 0)
                .map((s) => s.trim())
                .slice(0, 4)
            }
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
          : {}),
        ...(Array.isArray(p.opposes_families) && p.opposes_families.length > 0
          ? {
              opposes_families: p.opposes_families
                .filter((s) => typeof s === "string" && s.trim().length > 0)
                .map((s) => s.trim())
                .slice(0, 4)
            }
          : {})
      }))
      .filter((p) => p.evidence_cite.length > 0)
  };
}

export { extractPrinciples };
