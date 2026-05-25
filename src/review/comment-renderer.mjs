function findPrinciple(principles, id) {
  return principles.find((p) => p.id === id) || null;
}

function renderViolationComment(violation, principle) {
  const lines = [];
  const polarity = principle.polarity === "do" ? "Team principle" : "Team antipattern";
  lines.push(`${polarity}: ${principle.rule}`);
  if (principle.rationale) lines.push("");
  if (principle.rationale) lines.push(`> ${principle.rationale}`);
  lines.push("");
  lines.push(violation.message);
  if (principle.examples_to_follow && principle.examples_to_follow.length > 0) {
    lines.push("");
    lines.push(
      `**Team example to follow:** ${principle.examples_to_follow
        .map((c) => `\`${c}\``)
        .join(", ")}`
    );
  }
  if (violation.suggested_fix) {
    lines.push("");
    lines.push(`**Fix:** ${violation.suggested_fix}`);
  }
  lines.push("");
  lines.push(
    `_From \`adr review\` · lens: \`${principle.lens}\` · principle: \`${principle.id}\`_`
  );
  return lines.join("\n");
}

// Render the same content for terminal output — color codes, tighter
// layout, single-line citations. The PR-comment version above is wider
// because GitHub renders Markdown.
function renderViolationForTerminal(violation, principle, index, total) {
  const lines = [];
  const sevTag =
    violation.severity === "high"
      ? "\x1b[31m[HIGH]\x1b[0m"
      : violation.severity === "low"
        ? "\x1b[2m[low]\x1b[0m"
        : "\x1b[33m[medium]\x1b[0m";
  lines.push(
    `\x1b[36m[${index + 1}/${total}]\x1b[0m ${sevTag} ${violation.file}:${violation.line}`
  );
  lines.push(`  \x1b[1m${principle.rule}\x1b[0m`);
  if (principle.rationale) {
    lines.push(`  \x1b[2m${principle.rationale}\x1b[0m`);
  }
  lines.push(`  ${violation.message}`);
  if (principle.examples_to_follow && principle.examples_to_follow.length > 0) {
    lines.push(
      `  \x1b[2mteam example: ${principle.examples_to_follow.join(", ")}\x1b[0m`
    );
  }
  if (violation.suggested_fix) {
    lines.push(`  \x1b[2mfix: ${violation.suggested_fix}\x1b[0m`);
  }
  return lines.join("\n");
}

function severityRank(severity) {
  if (severity === "high") return 0;
  if (severity === "medium") return 1;
  return 2;
}

function rankViolations(violations) {
  return [...violations].sort((a, b) => {
    const r = severityRank(a.severity) - severityRank(b.severity);
    if (r !== 0) return r;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return (a.line || 0) - (b.line || 0);
  });
}

export {
  findPrinciple,
  renderViolationComment,
  renderViolationForTerminal,
  rankViolations,
  severityRank
};
