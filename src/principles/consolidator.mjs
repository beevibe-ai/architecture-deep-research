import { callLlmJson } from "../kernel.mjs";

async function consolidatePrinciples({
  lenses,
  perLensExtractions,
  interviewLog
}) {
  const raw = await callLlmJson({
    label: "principles_consolidator",
    system: [
      "You are the principles consolidator for `adr principles init`.",
      "",
      "Inputs:",
      "- lenses: the lenses we picked for this team",
      "- per_lens: positive_patterns, antipatterns, ambiguities per lens",
      "- interview_log: questions the user answered (or skipped)",
      "",
      "Job: produce the FINAL principles list for this team. Each",
      "principle becomes a check that `adr review` will run at PR time,",
      "so they must be specific, reviewable, and grounded in evidence.",
      "",
      "Rules:",
      "- Every principle keeps its lens slug.",
      "- polarity is 'do' for things the team follows, 'dont' for",
      "  things the team rejects.",
      "- evidence_cite must include real file:line citations from the",
      "  scan extractions. Do not invent paths.",
      "- examples_to_follow: 1-3 file:line citations from the team's",
      "  own code showing the principle in action.",
      "- examples_to_avoid: optional — file:line citations of code",
      "  that violates the principle (often from TODO/FIXME hits or",
      "  deprecated-marked files).",
      "- confirmed_by_interview: true ONLY when an interview answer",
      "  directly resolved this principle's ambiguity. Otherwise false.",
      "- confidence:",
      "    'high'   — confirmed by interview OR multiple independent",
      "               citations + clear team posture in docs",
      "    'medium' — single citation or inferred from manifests alone",
      "    'low'    — weak signal, included for transparency but the",
      "               user should review before relying on it",
      "",
      "- Use the interview log to:",
      "  (a) resolve ambiguities into concrete principles",
      "  (b) drop ambiguities the user explicitly rejected",
      "  (c) bump confidence to 'high' for principles the user confirmed",
      "",
      "- Skipped interview answers leave the principle unchanged from",
      "  the extraction (medium confidence).",
      "",
      "- Skip principles that have ONLY a low-confidence signal AND no",
      "  interview confirmation. Quality over quantity.",
      "",
      "Output JSON:",
      "{",
      "  principles: [",
      "    {",
      "      id: string (stable kebab-case slug, e.g. 'state-via-zustand-stores'),",
      "      lens: string (lens slug),",
      "      polarity: 'do' | 'dont',",
      "      rule: string (the principle, written as an actionable rule),",
      "      rationale: string (why this team follows it — one sentence),",
      "      evidence_cite: [string] (file:line citations),",
      "      examples_to_follow: [string] (file:line citations from team code),",
      "      examples_to_avoid: [string],  // optional",
      "      confirmed_by_interview: boolean,",
      "      confidence: 'high' | 'medium' | 'low'",
      "    }",
      "  ]",
      "}"
    ].join("\n"),
    user: JSON.stringify({
      lenses,
      per_lens: perLensExtractions,
      interview_log: interviewLog
    })
  });

  const principles = Array.isArray(raw.principles) ? raw.principles : [];
  return principles
    .filter(
      (p) =>
        p &&
        typeof p === "object" &&
        typeof p.id === "string" &&
        p.id.trim() &&
        typeof p.rule === "string" &&
        p.rule.trim()
    )
    .map((p) => ({
      id: String(p.id).trim(),
      lens: typeof p.lens === "string" ? p.lens.trim() : "",
      polarity: p.polarity === "dont" ? "dont" : "do",
      rule: p.rule.trim(),
      rationale:
        typeof p.rationale === "string" ? p.rationale.trim() : "",
      evidence_cite: Array.isArray(p.evidence_cite)
        ? p.evidence_cite
            .filter((s) => typeof s === "string" && s.trim())
            .map((s) => s.trim())
        : [],
      examples_to_follow: Array.isArray(p.examples_to_follow)
        ? p.examples_to_follow
            .filter((s) => typeof s === "string" && s.trim())
            .map((s) => s.trim())
        : [],
      examples_to_avoid: Array.isArray(p.examples_to_avoid)
        ? p.examples_to_avoid
            .filter((s) => typeof s === "string" && s.trim())
            .map((s) => s.trim())
        : [],
      confirmed_by_interview: Boolean(p.confirmed_by_interview),
      confidence:
        p.confidence === "high" || p.confidence === "low"
          ? p.confidence
          : "medium"
    }))
    .filter((p) => p.evidence_cite.length > 0);
}

export { consolidatePrinciples };
