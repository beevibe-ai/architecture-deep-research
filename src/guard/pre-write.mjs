import { readFile } from "node:fs/promises";
import path from "node:path";

// Read JSON from stdin. Claude Code passes the tool call payload here when
// a PreToolUse hook fires.
async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function topLevelDir(filePath) {
  if (!filePath) return null;
  const normalized = path.normalize(filePath).replace(/^\.\//, "");
  const segments = normalized.split(path.sep).filter(Boolean);
  return segments[0] || null;
}

function citeTopLevel(cite) {
  if (typeof cite !== "string") return null;
  const trimmed = cite.trim();
  if (!trimmed) return null;
  const [pathPart] = trimmed.split(":");
  return topLevelDir(pathPart);
}

// Pick principles that look relevant to the edit. Heuristic: any principle
// whose example_to_follow citation shares a top-level dir with the edited
// file. Plus any principle whose lens matches a known broad lens (those
// always apply). No LLM call — this is the hot path for every Edit/Write.
function pickRelevantPrinciples(principles, filePath) {
  const top = topLevelDir(filePath);
  const BROADLY_APPLICABLE_LENSES = new Set([
    "llm-call-discipline",
    "schema-validate-before-write",
    "event-stream-shape",
    "test-fixture-discipline"
  ]);

  const scored = principles.map((p) => {
    const citeMatches = (p.examples_to_follow || [])
      .map(citeTopLevel)
      .filter(Boolean);
    const sameTopLevel = Boolean(top && citeMatches.includes(top));
    const broadLens = BROADLY_APPLICABLE_LENSES.has(p.lens || "");
    // Relevance is binary — share a top-level OR be a broad lens. Confidence
    // and interview confirmation are tie-breakers within the relevant set,
    // not signals that an unrelated principle should fire.
    const relevant = sameTopLevel || broadLens;
    let score = 0;
    if (sameTopLevel) score += 3;
    if (broadLens) score += 2;
    if (p.confirmed_by_interview) score += 1;
    if (p.confidence === "high") score += 1;
    return { principle: p, score, relevant };
  });

  const filtered = scored.filter((s) => s.relevant);
  filtered.sort((a, b) => b.score - a.score);
  return filtered.slice(0, 6).map((s) => s.principle);
}

function renderContext(filePath, principles) {
  const lines = [];
  lines.push(
    `Team principles relevant to \`${filePath}\` (from \`.adr/principles.json\`, discovered by adr principles init):`
  );
  lines.push("");
  for (const p of principles) {
    const polarity = p.polarity === "do" ? "DO" : "DON'T";
    lines.push(`- **${polarity}** _(${p.lens})_: ${p.rule}`);
    if (p.examples_to_follow && p.examples_to_follow.length > 0) {
      lines.push(
        `  Team example: \`${p.examples_to_follow[0]}\``
      );
    }
  }
  lines.push("");
  lines.push(
    "If a principle conflicts with what the user asked for, surface the conflict — don't silently override either side."
  );
  return lines.join("\n");
}

// Compose the Claude Code hook response. The hook contract is:
//   - exit 0 to allow the tool call (no decision wraps it)
//   - print JSON to stdout with `additionalContext` to inject context
//   - print nothing if there's nothing useful to add
async function runPreWriteHook({ repoPath: explicitRepo } = {}) {
  const repoPath = explicitRepo || process.cwd();
  const principlesPath = path.join(repoPath, ".adr", "principles.json");

  let principlesArtifact;
  try {
    principlesArtifact = JSON.parse(await readFile(principlesPath, "utf8"));
  } catch {
    // Silent no-op when principles.json doesn't exist — this hook ships
    // with the plugin, so users without a principles file should not see
    // noise on every Edit/Write.
    return { status: "no_principles", emitted: false };
  }

  const payload = await readStdinJson();
  const toolInput = payload.tool_input || {};
  const filePath = toolInput.file_path || toolInput.path || null;
  if (!filePath) return { status: "no_file_path", emitted: false };

  const principles = principlesArtifact.principles || [];
  if (principles.length === 0) return { status: "empty_principles", emitted: false };

  const relPath = path.isAbsolute(filePath)
    ? path.relative(repoPath, filePath)
    : filePath;
  const relevant = pickRelevantPrinciples(principles, relPath);
  if (relevant.length === 0) return { status: "no_relevant_principles", emitted: false };

  const context = renderContext(relPath, relevant);
  // Claude Code hook response:
  //   { "hookSpecificOutput": { "hookEventName": "PreToolUse",
  //     "additionalContext": "..." } }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: context
      }
    })
  );
  return {
    status: "context_injected",
    emitted: true,
    principle_ids: relevant.map((p) => p.id)
  };
}

export { runPreWriteHook, pickRelevantPrinciples, renderContext };
