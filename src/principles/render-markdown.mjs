function escapeMd(value) {
  return String(value || "").replace(/\|/g, "\\|");
}

function renderPrinciplesMarkdown(artifact) {
  const lines = [];
  lines.push("# Team principles");
  lines.push("");
  lines.push(
    `Discovered by \`adr principles init\` on ${artifact.source.scanned_at}. ` +
      `${artifact.lenses.length} lenses, ${artifact.principles.length} principles.`
  );
  lines.push("");
  lines.push(
    "Run `adr review <PR#>` (or `adr review --staged`) to check a change " +
      "against this list. Run `adr principles init` again to refresh."
  );
  lines.push("");

  // ── PRODUCT INTENT — the portrait of what this product is and what
  // ── the team stands for. Leads the artifact so a reader gets the big
  // ── picture before drowning in per-lens rules.
  const intent = artifact.product_intent;
  if (intent && (intent.identity || intent.architectural_intent?.length)) {
    if (intent.identity) {
      lines.push("## What this is");
      lines.push("");
      lines.push(intent.identity);
      lines.push("");
    }

    if (intent.architectural_intent?.length > 0) {
      lines.push("## Architectural intent");
      lines.push("");
      lines.push(
        "The foundational decisions everything else hangs off of."
      );
      lines.push("");
      for (const item of intent.architectural_intent) {
        lines.push(`### ${escapeMd(item.name)}`);
        lines.push("");
        if (item.why) {
          lines.push(item.why);
          lines.push("");
        }
        if (item.evidence_cite?.length > 0) {
          lines.push(
            `_Anchored in: ${item.evidence_cite.map((c) => `\`${c}\``).join(", ")}_`
          );
          lines.push("");
        }
      }
    }

    if (intent.product_philosophy?.length > 0) {
      lines.push("## Product philosophy");
      lines.push("");
      lines.push(
        "Recurring design principles. The team's taste, not its tech stack."
      );
      lines.push("");
      for (const item of intent.product_philosophy) {
        const cites =
          item.evidence_cite?.length > 0
            ? ` _(${item.evidence_cite.map((c) => `\`${c}\``).join(", ")})_`
            : "";
        lines.push(`- **${escapeMd(item.name)}** — ${escapeMd(item.statement)}${cites}`);
      }
      lines.push("");
    }

    if (intent.non_goals?.length > 0) {
      lines.push("## Non-goals");
      lines.push("");
      lines.push(
        "What the team explicitly chose NOT to do — often more revealing than what they did."
      );
      lines.push("");
      for (const item of intent.non_goals) {
        const cites =
          item.evidence_cite?.length > 0
            ? ` _(${item.evidence_cite.map((c) => `\`${c}\``).join(", ")})_`
            : "";
        lines.push(`- ${escapeMd(item.statement)}${cites}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  // ── CODE-LEVEL PRINCIPLES — the per-lens review rules.
  lines.push("## Code-level lenses");
  lines.push("");
  lines.push(
    "Review angles a senior engineer would catch in a PR for this codebase."
  );
  lines.push("");
  for (const lens of artifact.lenses) {
    lines.push(`- **${lens.name}** (\`${lens.slug}\`) — ${lens.rationale}`);
  }
  lines.push("");

  const byLens = new Map();
  for (const lens of artifact.lenses) byLens.set(lens.slug, []);
  for (const p of artifact.principles) {
    if (!byLens.has(p.lens)) byLens.set(p.lens, []);
    byLens.get(p.lens).push(p);
  }

  lines.push("## Code-level principles");
  lines.push("");
  for (const lens of artifact.lenses) {
    const principles = byLens.get(lens.slug) || [];
    if (principles.length === 0) continue;
    lines.push(`### ${lens.name}`);
    lines.push("");
    for (const p of principles) {
      const polarityTag = p.polarity === "do" ? "DO" : "DON'T";
      const confidenceTag =
        p.confidence === "high"
          ? ""
          : ` _(${p.confidence} confidence${
              p.confirmed_by_interview ? "" : ", inferred"
            })_`;
      lines.push(`#### ${polarityTag}: ${escapeMd(p.rule)}${confidenceTag}`);
      lines.push("");
      if (p.rationale) {
        lines.push(p.rationale);
        lines.push("");
      }
      if (p.examples_to_follow.length > 0) {
        lines.push("**Team example to follow:**");
        for (const cite of p.examples_to_follow) {
          lines.push(`- \`${cite}\``);
        }
        lines.push("");
      }
      if (p.examples_to_avoid.length > 0) {
        lines.push("**Examples to avoid:**");
        for (const cite of p.examples_to_avoid) {
          lines.push(`- \`${cite}\``);
        }
        lines.push("");
      }
      if (p.evidence_cite.length > 0) {
        const evidenceLine = p.evidence_cite
          .map((cite) => `\`${cite}\``)
          .join(", ");
        lines.push(`_Evidence: ${evidenceLine}_`);
        lines.push("");
      }
    }
  }

  if (Array.isArray(artifact.interview_log) && artifact.interview_log.length > 0) {
    lines.push("## Interview log");
    lines.push("");
    for (const entry of artifact.interview_log) {
      const answer = entry.skipped
        ? "_(skipped)_"
        : escapeMd(entry.answer);
      lines.push(`- **Q:** ${escapeMd(entry.question)}`);
      lines.push(`  **A:** ${answer}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export { renderPrinciplesMarkdown };
