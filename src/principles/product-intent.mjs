// Product intent extractor — the "what is this product" step that runs
// before the lens / pattern / consolidator chain. Reads the team's
// highest-signal docs (README, ARCHITECTURE, CLAUDE.md, prior ADRs) and
// the repo's structural shape, then asks an LLM:
//
//   "Forget linting. What is this product, what foundational decisions
//    is it built on, what philosophy recurs in how the team writes
//    code, and what did they explicitly choose NOT to do?"
//
// One LLM call. Cheap (~$0.02). Output becomes the leading section of
// principles.md so the artifact reads as a portrait of the product,
// not just a list of static rules.

import { callLlmJson } from "../kernel.mjs";

function summarizeScanForIntent(scan, sourceSample) {
  return {
    repo_path: scan.repo_path,
    top_level: scan.top_level,
    tree_excerpt: scan.tree.slice(0, 60),
    // All docs the scan picked up — README, ARCHITECTURE, CLAUDE.md,
    // prior ADRs, etc. These are the highest-signal inputs for intent.
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
    codeowners_path: scan.codeowners?.path || null,
    git_signals: scan.git_signals
      ? {
          contributors_shortlog: scan.git_signals.contributors_shortlog
        }
      : null,
    // A small source sample helps the LLM ground philosophy claims in
    // real code patterns (e.g. the "specialists take actions" rule lives
    // in a real route handler, not just in CLAUDE.md).
    source_samples: (sourceSample?.samples || []).slice(0, 8),
    // Rich comments — the team's own written-down WHY. File-header
    // intent, rationale comments, prohibition comments, JSDoc tags.
    rich_comments: scan.rich_comments || null,
    // Test descriptors — describe/it/test names as executable invariants.
    test_descriptors: scan.test_descriptors?.descriptors?.slice(0, 30) || [],
    // GitHub signals — closed wontfix issues + arch-keyword merged PRs.
    // Best-effort; absent when origin isn't github or gh CLI missing.
    github_signals: scan.github_signals?.available
      ? {
          rejected_issues: scan.github_signals.rejected_issues,
          arch_keyword_prs: scan.github_signals.arch_keyword_prs
        }
      : null
  };
}

async function extractProductIntent(scan, sourceSample) {
  const raw = await callLlmJson({
    label: "principles_product_intent",
    system: [
      "You are the product-intent extractor for `adr principles init`.",
      "",
      "Read the team's docs (README, ARCHITECTURE, CLAUDE.md, prior",
      "ADRs, manifests) and produce a portrait of the product at the",
      "level a senior engineer or new CTO would describe it on day",
      "one. NOT a list of code-style rules — those come later.",
      "",
      "Four sections to produce:",
      "",
      "Use ALL the inputs — not just the docs. Specifically:",
      "  - rich_comments.headers : file-header comments describing what",
      "    a module is for. Pure intent.",
      "  - rich_comments.rationales : comments containing 'why',",
      "    'because', 'see ADR', 'intentionally' — the team's own WHY.",
      "  - rich_comments.prohibitions : 'do not', 'don't', 'never',",
      "    'must not' — explicit antipattern flags pre-written by the team.",
      "  - test_descriptors : describe/it/test names. Executable",
      "    invariants. 'it(\"must not allow duplicate selections\")' is",
      "    a principle the team encoded in CI.",
      "  - github_signals.rejected_issues : closed issues with wontfix /",
      "    out-of-scope / not-planned labels. Direct input for non_goals.",
      "  - github_signals.arch_keyword_prs : merged PRs whose titles",
      "    contain refactor/migrate/switch/move/etc. The PR descriptions",
      "    are where the team wrote the rationale for big architectural",
      "    changes. Direct input for architectural_intent.why.",
      "",
      "1. identity (string, 1-2 sentences)",
      "   What IS this product? Plain language a non-expert could",
      "   understand. Avoid marketing voice — read the README and",
      "   say what it really is.",
      "   Good: \"Beevibe is a self-hosted shared workspace where",
      "         humans and AI agents work side by side. One Docker",
      "         stack, one Postgres + pgvector, one daemon per laptop.\"",
      "   Bad: \"A revolutionary AI-native platform empowering...\"",
      "",
      "2. architectural_intent (array of 3-6 items)",
      "   The foundational decisions the team made that everything",
      "   else hangs off of. Each item has:",
      "     - name (one phrase: the decision)",
      "     - why (one sentence: why this beat the alternatives)",
      "     - evidence_cite (file paths from the docs that establish it)",
      "   These are decisions like:",
      "     - 'One Postgres, no microservices' (vs. service-per-domain)",
      "     - 'Daemon pinned to user's laptop' (vs. remote sandbox)",
      "     - 'Core compiles to dist/' (vs. ts-node everywhere)",
      "     - 'Team agents route, specialists act' (architectural pattern)",
      "   Prefer architectural decisions over tech choices. \"Uses",
      "   Postgres\" isn't an intent — \"All state through one Postgres,",
      "   no microservices\" is.",
      "",
      "3. product_philosophy (array of 3-6 items)",
      "   The recurring design principles that show up across the",
      "   codebase — the team's *taste*, not its tech stack. Each item:",
      "     - name (one phrase)",
      "     - statement (one sentence in the team's voice)",
      "     - evidence_cite (file paths or doc sections supporting it)",
      "   Examples:",
      "     - \"No mocks, no seeds — real systems against real systems\"",
      "     - \"Lazy users — default to interactive, never edit markdown\"",
      "     - \"Plain language, real point first; no consultant scaffolding\"",
      "   If CLAUDE.md or AGENTS.md exists, it likely encodes these",
      "   explicitly — those are gold. Quote verbatim where it fits.",
      "",
      "4. non_goals (array of 2-5 items)",
      "   What the team explicitly chose NOT to do. Often more",
      "   revealing than what they did. Each item:",
      "     - statement (one sentence)",
      "     - evidence_cite (file paths that establish the rejection)",
      "   Look for: \"Non-goals\" sections, \"Rejected alternatives\" in",
      "   prior ADRs, removed deps in git history, \"why we don't do X\"",
      "   in CLAUDE.md.",
      "",
      "Quality bar:",
      "- Every claim must cite a real path from the input. No invented",
      "  files. Each cite is `path` or `path:line`.",
      "- Prefer the team's own words from docs. Don't substitute",
      "  generic descriptions when the team already wrote a better one.",
      "- If the repo has no README or docs, return short empty-ish",
      "  output rather than making things up.",
      "",
      "Output JSON:",
      "{",
      "  identity: string,",
      "  architectural_intent: [",
      "    { name: string, why: string, evidence_cite: [string] }",
      "  ],",
      "  product_philosophy: [",
      "    { name: string, statement: string, evidence_cite: [string] }",
      "  ],",
      "  non_goals: [",
      "    { statement: string, evidence_cite: [string] }",
      "  ]",
      "}"
    ].join("\n"),
    user: JSON.stringify({
      scan: summarizeScanForIntent(scan, sourceSample)
    })
  });

  return {
    identity:
      typeof raw.identity === "string" && raw.identity.trim()
        ? raw.identity.trim()
        : "",
    architectural_intent: Array.isArray(raw.architectural_intent)
      ? raw.architectural_intent
          .filter(
            (i) =>
              i &&
              typeof i === "object" &&
              typeof i.name === "string" &&
              i.name.trim()
          )
          .map((i) => ({
            name: i.name.trim(),
            why: typeof i.why === "string" ? i.why.trim() : "",
            evidence_cite: Array.isArray(i.evidence_cite)
              ? i.evidence_cite
                  .filter((s) => typeof s === "string" && s.trim())
                  .map((s) => s.trim())
              : []
          }))
      : [],
    product_philosophy: Array.isArray(raw.product_philosophy)
      ? raw.product_philosophy
          .filter(
            (i) =>
              i &&
              typeof i === "object" &&
              typeof i.name === "string" &&
              i.name.trim()
          )
          .map((i) => ({
            name: i.name.trim(),
            statement:
              typeof i.statement === "string" ? i.statement.trim() : "",
            evidence_cite: Array.isArray(i.evidence_cite)
              ? i.evidence_cite
                  .filter((s) => typeof s === "string" && s.trim())
                  .map((s) => s.trim())
              : []
          }))
      : [],
    non_goals: Array.isArray(raw.non_goals)
      ? raw.non_goals
          .filter(
            (i) =>
              i &&
              typeof i === "object" &&
              typeof i.statement === "string" &&
              i.statement.trim()
          )
          .map((i) => ({
            statement: i.statement.trim(),
            evidence_cite: Array.isArray(i.evidence_cite)
              ? i.evidence_cite
                  .filter((s) => typeof s === "string" && s.trim())
                  .map((s) => s.trim())
              : []
          }))
      : []
  };
}

export { extractProductIntent };
