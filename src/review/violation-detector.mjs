import { callLlmJson } from "../kernel.mjs";
import { renderFileForLlm } from "./hunk-parser.mjs";

function summarizePrinciplesForReview(principles) {
  return principles.map((p) => ({
    id: p.id,
    lens: p.lens,
    polarity: p.polarity,
    rule: p.rule,
    rationale: p.rationale || "",
    examples_to_follow: p.examples_to_follow || [],
    examples_to_avoid: p.examples_to_avoid || []
  }));
}

async function detectViolationsForFile(file, principles) {
  const rendered = renderFileForLlm(file);

  const raw = await callLlmJson({
    label: "review_violation_detector",
    system: [
      "You are the violation detector for `adr review`.",
      "",
      "You are given:",
      "- A team's principles (id, lens, polarity, rule, rationale,",
      "  examples_to_follow, examples_to_avoid). These were discovered",
      "  by `adr principles init` from this team's own codebase. They",
      "  are what a senior team lead would comment on in a PR.",
      "- A single file's changes from a pull request, rendered as",
      "  HUNK blocks with line numbers prefixed.",
      "",
      "Your job: surface concrete violations of these principles in",
      "the diff. NOT generic code review. Only violations that map to",
      "a specific principle.",
      "",
      "Rules of engagement:",
      "- Only flag ADDED lines (lines starting with '+'). Deleted",
      "  lines aren't the new behavior — they're going away.",
      "- Cite the exact new-file line number from the prefix at the",
      "  start of each line in the HUNK. This becomes the inline",
      "  comment target in `gh pr review`.",
      "- principle_id MUST match one in the principles list. Do not",
      "  invent IDs.",
      "- Be specific in the message — name the line, name the rule,",
      "  point at the team example to follow if there is one. Avoid",
      "  generic prose like 'consider refactoring'.",
      "- Severity:",
      "    'high'   — clear violation, team lead would comment for sure",
      "    'medium' — likely violation, depends on local context",
      "    'low'    — pattern conflict, may be intentional",
      "- If no principles apply, return an empty violations list. Empty",
      "  is a valid answer. Do not flag style/formatting/typos — those",
      "  are not principle violations.",
      "",
      "Output JSON:",
      "{",
      "  violations: [",
      "    {",
      "      principle_id: string (must match input principle id),",
      "      file: string (the file path being reviewed),",
      "      line: number (new-file line, from the HUNK prefix),",
      "      severity: 'high' | 'medium' | 'low',",
      "      message: string (1-3 sentences naming the issue),",
      "      suggested_fix: string  // optional, short pointer at the fix",
      "    }",
      "  ]",
      "}"
    ].join("\n"),
    user: JSON.stringify({
      principles: summarizePrinciplesForReview(principles),
      diff: rendered
    })
  });

  const principleIds = new Set(principles.map((p) => p.id));
  const violations = Array.isArray(raw.violations) ? raw.violations : [];
  return violations
    .filter(
      (v) =>
        v &&
        typeof v === "object" &&
        typeof v.principle_id === "string" &&
        principleIds.has(v.principle_id)
    )
    .map((v) => ({
      principle_id: v.principle_id,
      file: typeof v.file === "string" && v.file.trim() ? v.file.trim() : file.new_path,
      line: Number.isFinite(v.line) ? Number(v.line) : null,
      severity:
        v.severity === "high" || v.severity === "low" ? v.severity : "medium",
      message:
        typeof v.message === "string" && v.message.trim()
          ? v.message.trim()
          : "",
      suggested_fix:
        typeof v.suggested_fix === "string" ? v.suggested_fix.trim() : ""
    }))
    .filter((v) => v.message.length > 0 && v.line != null);
}

async function detectViolations(files, principles) {
  // Per-file parallelism. Each file is one LLM call so token cost stays
  // bounded by file size, not PR size.
  const results = await Promise.all(
    files
      .filter((file) => !file.binary && file.hunks.length > 0)
      .map((file) => detectViolationsForFile(file, principles))
  );
  return results.flat();
}

export { detectViolations, detectViolationsForFile };
