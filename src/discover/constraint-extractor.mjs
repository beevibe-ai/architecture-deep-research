import { callLlmJson } from "../kernel.mjs";

function summarizeScanForConstraints(scan) {
  return {
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
    docs: scan.docs.map((d) => ({
      path: d.path,
      content: d.content
    })),
    codeowners: scan.codeowners,
    git_signals: scan.git_signals
      ? {
          first_commit_at: scan.git_signals.first_commit_at,
          last_commit_at: scan.git_signals.last_commit_at,
          contributors_shortlog: scan.git_signals.contributors_shortlog
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

async function extractConstraints(scan, { decision } = {}) {
  const raw = await callLlmJson({
    label: "discover_constraint_extractor",
    system: [
      "You are the discovered-constraints extractor for Architecture Deep Research.",
      "Read the structured repo scan and identify the constraints that bound any architecture",
      "decision: the stack the team is on, where the code deploys, what compliance signals are",
      "visible, and any hints about team size or codebase age.",
      "",
      "Rules:",
      "- Use only evidence from the scan. Cite each item with the path it came from.",
      "- For compliance, look for explicit mentions: SOC 2, HIPAA, GDPR, PCI, FedRAMP, ISO 27001,",
      "  audit, lineage, traceability, right-to-deletion. Do not infer from domain alone.",
      "- For deploy_target, pick the most-specific platform you can identify; if there are",
      "  multiple, pick the dominant one and mention the others in evidence_cite.",
      "- team_size_hint and codebase_age_hint are short strings (e.g. 'small (3 contributors per shortlog)',",
      "  'codebase first commit 2024-08-12'). Use 'unknown' if the scan is silent.",
      "",
      "Output JSON with:",
      "- stack: [{ name, category, evidence_cite: [string] }] (category examples: language, framework, datastore, queue, search)",
      "- deploy_target: { platform: string, evidence_cite: [string] }",
      "- compliance_signals: [{ name, evidence_cite: [string] }]",
      "- team_size_hint: string",
      "- codebase_age_hint: string"
    ].join("\n"),
    user: JSON.stringify({
      decision: decision || null,
      scan: summarizeScanForConstraints(scan)
    })
  });

  const stack = Array.isArray(raw.stack) ? raw.stack : [];
  const compliance = Array.isArray(raw.compliance_signals) ? raw.compliance_signals : [];
  const deploy =
    raw.deploy_target && typeof raw.deploy_target === "object"
      ? raw.deploy_target
      : { platform: "unknown", evidence_cite: [] };

  return {
    stack: stack
      .filter((s) => s && typeof s === "object" && typeof s.name === "string" && s.name.trim())
      .map((s) => ({
        name: String(s.name).trim(),
        category: typeof s.category === "string" ? s.category.trim() : "other",
        evidence_cite: normalizeCite(s.evidence_cite)
      }))
      .filter((s) => s.evidence_cite.length > 0),
    deploy_target: {
      platform:
        typeof deploy.platform === "string" && deploy.platform.trim()
          ? deploy.platform.trim()
          : "unknown",
      evidence_cite: normalizeCite(deploy.evidence_cite)
    },
    compliance_signals: compliance
      .filter((c) => c && typeof c === "object" && typeof c.name === "string" && c.name.trim())
      .map((c) => ({
        name: String(c.name).trim(),
        evidence_cite: normalizeCite(c.evidence_cite)
      }))
      .filter((c) => c.evidence_cite.length > 0),
    team_size_hint:
      typeof raw.team_size_hint === "string" && raw.team_size_hint.trim()
        ? raw.team_size_hint.trim()
        : "unknown",
    codebase_age_hint:
      typeof raw.codebase_age_hint === "string" && raw.codebase_age_hint.trim()
        ? raw.codebase_age_hint.trim()
        : "unknown"
  };
}

export { extractConstraints };
