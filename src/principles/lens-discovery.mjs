import { callLlmJson } from "../kernel.mjs";

function summarizeScanForLensDiscovery(scan, sourceSample) {
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
      platform: c.platform
    })),
    observability_signals: scan.observability_signals,
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

async function discoverLenses(scan, sourceSample) {
  const raw = await callLlmJson({
    label: "principles_lens_discovery",
    system: [
      "You are the lens discoverer for `adr principles init`.",
      "",
      "IMPORTANT: A 'lens' is something a senior engineer would catch in a",
      "PR REVIEW of this codebase. NOT a product feature. NOT a marketing",
      "section. Lenses are reviewable angles — places where a PR can go",
      "wrong, and a thoughtful reviewer would leave a comment.",
      "",
      "GOOD lens names (concrete, reviewable):",
      "- 'state-boundaries' — where component-local state vs store state lives",
      "- 'schema-validate-before-write' — every persisted artifact validated",
      "- 'error-handling-posture' — Result types vs throw vs silent return",
      "- 'event-stream-shape' — what gets appended to events.jsonl + when",
      "- 'llm-call-discipline' — every callLlmJson goes through one helper",
      "- 'cli-subcommand-pattern' — how new subcommands attach in scripts/adr.mjs",
      "- 'test-fixture-discipline' — how regression tests mock LLM responses",
      "",
      "BAD lens names (product feature descriptions, NOT review angles):",
      "- 'Agentic Research Kernel' — that's the product, not a review angle",
      "- 'Decision Reporting and Synthesis' — that's a feature group",
      "- 'API Key and Environment Configuration' — vague, not reviewable",
      "- 'Plugin and MCP Integration' — feature description, not posture",
      "",
      "Test for each lens you propose: 'If a PR violated this lens,",
      "could I write a comment pointing at a specific line and say `we",
      "don't do X here, we do Y`?'  If no, the lens is wrong.",
      "",
      "Read the repo scan AND the source_samples below. Source samples",
      "show real conventions; the docs/manifests are scaffolding.",
      "",
      "Propose 4-8 lenses. Each MUST:",
      "- have a slug a senior engineer would understand at a glance",
      "- cite concrete signals from source_samples or docs (file paths",
      "  that exist in the scan, not invented ones)",
      "- be reviewable: violating it should produce a concrete PR comment",
      "",
      "Output JSON:",
      "{",
      "  lenses: [",
      "    {",
      "      slug: string (kebab-case, e.g. 'state-boundaries'),",
      "      name: string (human-readable, e.g. 'State boundaries'),",
      "      rationale: string (one sentence: what a reviewer catches under this lens),",
      "      scan_signals: [string] (file paths from the scan that anchored you)",
      "    }",
      "  ]",
      "}"
    ].join("\n"),
    user: JSON.stringify({
      scan: summarizeScanForLensDiscovery(scan, sourceSample)
    })
  });

  const lenses = Array.isArray(raw.lenses) ? raw.lenses : [];

  return lenses
    .filter(
      (lens) =>
        lens &&
        typeof lens === "object" &&
        typeof lens.slug === "string" &&
        lens.slug.trim()
    )
    .map((lens) => ({
      slug: String(lens.slug).trim(),
      name: typeof lens.name === "string" ? lens.name.trim() : lens.slug,
      rationale:
        typeof lens.rationale === "string" ? lens.rationale.trim() : "",
      scan_signals: Array.isArray(lens.scan_signals)
        ? lens.scan_signals
            .filter((s) => typeof s === "string" && s.trim().length > 0)
            .map((s) => s.trim())
        : []
    }))
    .slice(0, 8);
}

export { discoverLenses };
