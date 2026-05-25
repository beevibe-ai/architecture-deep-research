import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { callLlmJson } from "../kernel.mjs";

async function generateInterviewQuestions(
  perLensExtractions,
  { priorInterviewLog = [] } = {}
) {
  // Only ask questions when the LLM extraction surfaced ambiguity or low-
  // confidence inference. Confident, well-evidenced principles don't need
  // the user's time. The user being lazy is a design constraint.
  //
  // In refresh mode, priorInterviewLog is non-empty — the generator must
  // skip questions that prior answers already resolved (otherwise refresh
  // just re-asks everything, defeating its purpose).
  const isRefresh = priorInterviewLog.length > 0;
  const raw = await callLlmJson({
    label: "principles_interview_generator",
    system: [
      "You are the interview generator for `adr principles init`.",
      "",
      "You have the per-lens extractions: positive_patterns,",
      "antipatterns, and ambiguities for each lens.",
      "",
      ...(isRefresh
        ? [
            "REFRESH MODE: a prior_interview_log is provided. The user",
            "already answered these questions in a previous run. DO NOT",
            "regenerate questions whose answers are already in the log —",
            "even if the wording or evidence has shifted slightly. Only",
            "generate questions for NEW ambiguities that the prior log",
            "does not resolve.",
            "",
            "If the prior log answered a question and the new ambiguity is",
            "substantively the same (same lens, same conflict), skip it.",
            "If the team's posture might have shifted (new evidence",
            "contradicts the prior answer), DO generate the question, and",
            "include a note in the text like '(prior answer was: X — has",
            "this changed?)'.",
            ""
          ]
        : []),
      "Your job: produce 4-8 questions that, when answered, resolve",
      "the highest-leverage ambiguities and confirm the highest-stakes",
      "principles. NOT more than 8 — users are lazy. In refresh mode,",
      "0 questions is the ideal outcome (no new ambiguities = stable",
      "principles).",
      "",
      "Question quality bar:",
      "- Each question MUST include the conflicting evidence inline",
      "  (file:line + one-line observation per side). The user needs",
      "  to see what you saw without leaving the terminal.",
      "- Prefer questions with concrete options (multiple-choice or",
      "  yes/no) over open-ended ones. Free text is fine when truly",
      "  needed, but most ambiguities have 2-3 reasonable resolutions.",
      "- Skip questions whose answer is obvious from the scan. Don't",
      "  burn the user's attention on confirmation theater.",
      "- One question per ambiguity max. Don't fragment.",
      "",
      "Output JSON:",
      "{",
      "  questions: [",
      "    {",
      "      id: string (q1, q2, ...),",
      "      lens: string (lens slug this question lives under),",
      "      text: string (the question, written conversationally),",
      "      conflicting_evidence: [",
      "        { cite: string, observation: string }",
      "      ],",
      "      options: [string]  // optional. 2-4 short answer options.",
      "    }",
      "  ]",
      "}"
    ].join("\n"),
    user: JSON.stringify({
      per_lens: perLensExtractions,
      ...(isRefresh ? { prior_interview_log: priorInterviewLog } : {})
    })
  });

  const questions = Array.isArray(raw.questions) ? raw.questions : [];
  return questions
    .filter(
      (q) =>
        q &&
        typeof q === "object" &&
        typeof q.text === "string" &&
        q.text.trim()
    )
    .map((q, index) => ({
      id: typeof q.id === "string" && q.id.trim() ? q.id.trim() : `q${index + 1}`,
      lens: typeof q.lens === "string" ? q.lens.trim() : "",
      text: q.text.trim(),
      conflicting_evidence: Array.isArray(q.conflicting_evidence)
        ? q.conflicting_evidence
            .filter(
              (c) =>
                c && typeof c.cite === "string" && c.cite.trim()
            )
            .map((c) => ({
              cite: c.cite.trim(),
              observation:
                typeof c.observation === "string"
                  ? c.observation.trim()
                  : ""
            }))
        : [],
      options: Array.isArray(q.options)
        ? q.options
            .filter((o) => typeof o === "string" && o.trim())
            .map((o) => o.trim())
            .slice(0, 4)
        : []
    }))
    .slice(0, 8);
}

async function runInteractiveInterview(questions, { onSkipAll } = {}) {
  if (questions.length === 0) return [];

  const rl = readline.createInterface({ input, output });
  const log = [];

  console.log("");
  console.log(
    `\x1b[1m${questions.length} questions to confirm what we found.\x1b[0m  ` +
      `\x1b[2mPress ENTER to skip a question, "q" to skip the rest.\x1b[0m`
  );
  console.log("");

  let skipRest = false;
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    if (skipRest) {
      log.push({
        question: q.text,
        lens: q.lens,
        answer: "",
        skipped: true
      });
      continue;
    }

    console.log(
      `\x1b[36m[${i + 1}/${questions.length}]\x1b[0m \x1b[1m${q.text}\x1b[0m`
    );
    if (q.lens) console.log(`\x1b[2m  lens: ${q.lens}\x1b[0m`);
    for (const cite of q.conflicting_evidence) {
      console.log(`\x1b[2m  ${cite.cite}\x1b[0m — ${cite.observation}`);
    }
    if (q.options.length > 0) {
      console.log("");
      q.options.forEach((opt, idx) => {
        console.log(`    ${idx + 1}. ${opt}`);
      });
      console.log("");
    }

    const answer = (await rl.question("  > ")).trim();
    if (answer.toLowerCase() === "q") {
      skipRest = true;
      log.push({
        question: q.text,
        lens: q.lens,
        answer: "",
        skipped: true
      });
      if (typeof onSkipAll === "function") onSkipAll();
      continue;
    }

    // Numeric short-circuit: if the user typed "1" and there are options,
    // expand to the option text. Saves typing the whole answer back.
    let resolved = answer;
    if (q.options.length > 0 && /^[0-9]+$/.test(answer)) {
      const idx = Number(answer) - 1;
      if (idx >= 0 && idx < q.options.length) {
        resolved = q.options[idx];
      }
    }

    log.push({
      question: q.text,
      lens: q.lens,
      answer: resolved,
      skipped: resolved.length === 0
    });
    console.log("");
  }

  rl.close();
  return log;
}

export { generateInterviewQuestions, runInteractiveInterview };
