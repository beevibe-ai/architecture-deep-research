import { callLlmJson } from "../kernel.mjs";

async function draftPrd({ decision, principles, constraints, issueBody, repoPath }) {
  const raw = await callLlmJson({
    label: "discover_prd_drafter",
    system: [
      "You are the PRD drafter for Architecture Deep Research's discover stage.",
      "Given the discovered patterns, anti-patterns, and constraints from a repo scan",
      "(plus optionally a GitHub issue body that prompted the architecture question),",
      "produce a markdown product-context document that the deep-research stage can",
      "consume as its input.",
      "",
      "The markdown MUST follow this shape (header levels, section names, bullet style):",
      "",
      "# Product Context: <Title>",
      "",
      "<2-3 sentence summary of what is being built and why this decision matters now.",
      " Lean on the issue body if provided. Stay grounded in the discovered evidence.>",
      "",
      "## Decision",
      "",
      "<One sentence naming the specific architecture decision being made>",
      "",
      "## Discovered context",
      "",
      "- <Pattern: name — description (cited paths)> (one bullet per important pattern, max 6)",
      "- <Anti-pattern: name — reason (cited paths)> (one bullet per important anti-pattern, max 4)",
      "- <Stack signal: name (cited paths)>",
      "- <Deploy target: platform (cited paths)>",
      "- <Compliance signal: name (cited paths)> (only if any)",
      "- Team size: <team_size_hint>",
      "- Codebase age: <codebase_age_hint>",
      "",
      "## Representative questions",
      "",
      "<Bullet list of 3-5 questions or workflows the resulting system must support.",
      " Derive these from the issue body if present, otherwise from the patterns and decision name.>",
      "",
      "## Important constraints",
      "",
      "<Bullet list. Re-state each compliance signal explicitly. Re-state each anti-pattern",
      " as a constraint (e.g. 'Anti-pattern X must not be reintroduced').>",
      "",
      "## Open questions",
      "",
      "<Bullet list. These are things the scan could NOT infer and that the user MUST fill in",
      " before running deep-research. Include at minimum: latency / SLA targets, data volumes,",
      " regulatory specifics beyond the discovered keywords, and budget envelope. Add",
      " decision-specific open questions when the discovered evidence is silent on them.>",
      "",
      "Rules:",
      "- Do not invent compliance frameworks, latency targets, or business constraints the scan does not show.",
      "- Cite paths in parentheses after each Discovered-context bullet, e.g. (CONTRIBUTING.md:47, docs/adr/0003.md).",
      "- Output ONLY the markdown, as a JSON string in field `markdown`. No other commentary.",
      "",
      "Output JSON with: { markdown: string }"
    ].join("\n"),
    user: JSON.stringify({
      decision,
      repo_path: repoPath,
      issue_body: issueBody || null,
      principles,
      constraints
    })
  });

  const markdown = typeof raw.markdown === "string" ? raw.markdown : "";
  if (!markdown.trim()) {
    throw new Error(
      "discover_prd_drafter: model did not return a markdown PRD draft. Got: " +
        JSON.stringify(raw).slice(0, 400)
    );
  }
  return markdown;
}

export { draftPrd };
