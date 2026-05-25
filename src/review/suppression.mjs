// Suppression — let users mark a specific line/principle as intentionally
// out of bounds, so `adr review` doesn't repeat the same comment after
// the team already accepted the deviation.
//
// Syntax (any one of these on the same line as the violation, or the line
// directly above):
//
//   // adr-ignore: principle-id-1, principle-id-2
//   # adr-ignore: principle-id-1
//   /* adr-ignore: principle-id-1 */
//   <!-- adr-ignore: principle-id-1 -->
//
// Multiple principles per comment, comma-separated. Whitespace is
// tolerated. Wildcard "*" suppresses all principles on that line — use
// sparingly; the bot loses signal.

const SUPPRESSION_PATTERN = /(?:\/\/|#|\/\*|<!--)\s*adr-ignore:\s*(.+?)$/;

function parseSuppressionLine(text) {
  const m = text.match(SUPPRESSION_PATTERN);
  if (!m) return null;
  // Strip trailing block-comment or HTML-comment terminators that the
  // capture group otherwise greedily eats. After this, the wildcard
  // form `*` parses correctly (previously the character class excluded
  // `*` because of `*/`, which silently dropped wildcards).
  const idsRaw = m[1]
    .replace(/\*\/\s*$/, "")
    .replace(/-->\s*$/, "")
    .trim();
  if (!idsRaw) return null;
  return idsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Walk the parsed file's hunks and return a Map<line, Set<id>> where each
// line in the new file that has a suppression comment maps to the set of
// principle ids it suppresses (or {"*"} for wildcard).
function suppressionMapForFile(file) {
  const byLine = new Map();
  for (const hunk of file.hunks) {
    for (const entry of hunk.lines) {
      if (entry.kind === "del") continue;
      if (entry.new_line == null) continue;
      const ids = parseSuppressionLine(entry.text);
      if (!ids) continue;
      let existing = byLine.get(entry.new_line);
      if (!existing) {
        existing = new Set();
        byLine.set(entry.new_line, existing);
      }
      for (const id of ids) existing.add(id);
    }
  }
  return byLine;
}

// Decide whether a violation is suppressed. Comment on the SAME line as
// the violation counts. Comment on the line DIRECTLY ABOVE counts too
// (for the convention where the ignore comment precedes the offending
// statement). Wildcard "*" suppresses any principle.
function isViolationSuppressed(violation, suppressionMap) {
  const lines = [violation.line, violation.line - 1];
  for (const line of lines) {
    const ids = suppressionMap.get(line);
    if (!ids) continue;
    if (ids.has("*")) return { suppressed: true, on_line: line, kind: "wildcard" };
    if (ids.has(violation.principle_id)) {
      return { suppressed: true, on_line: line, kind: "exact" };
    }
  }
  return { suppressed: false };
}

// Run the filter over all violations + all files. Returns the kept
// violations + a summary the orchestrator can log + record in review.json.
function applySuppressions(violations, files) {
  const mapsByFile = new Map();
  for (const file of files) {
    mapsByFile.set(file.new_path, suppressionMapForFile(file));
  }
  const kept = [];
  const suppressed = [];
  for (const v of violations) {
    const map = mapsByFile.get(v.file);
    if (!map) {
      kept.push(v);
      continue;
    }
    const result = isViolationSuppressed(v, map);
    if (result.suppressed) {
      suppressed.push({ ...v, suppressed_on_line: result.on_line, kind: result.kind });
    } else {
      kept.push(v);
    }
  }
  return {
    kept,
    suppressed,
    summary: {
      total_violations: violations.length,
      kept: kept.length,
      suppressed: suppressed.length,
      by_file: Object.fromEntries(
        [...mapsByFile.entries()].map(([file, map]) => [file, map.size])
      )
    }
  };
}

export {
  applySuppressions,
  parseSuppressionLine,
  suppressionMapForFile,
  isViolationSuppressed
};
