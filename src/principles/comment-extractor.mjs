// Rich comment extractor. The existing repo-scan picks up TODO/FIXME
// hits as file:line markers but throws away the comment body. The body
// is where the team encodes WHY — exactly the signal we need for
// product-intent and per-lens extraction.
//
// We run over the source samples (already in memory) rather than the
// whole repo so this stays free (no extra file IO, no LLM call).
// The samples were chosen to be representative — their comments are
// the most consequential ones.
//
// Categories captured:
//
//   - marker  : TODO / FIXME / HACK / XXX / NOTE / WARNING / DEPRECATED
//               with the explanation text after the marker
//   - rationale: "why" / "because" / "see" / "intentionally" — the team's
//               written-down reasoning, signature for principle extraction
//   - prohibition: "do not" / "don't" / "never" / "must not" — explicit
//               antipattern flags
//   - header  : file- or module-header block at the top of a file
//   - jsdoc   : JSDoc/PyDoc with @-tags (@throws, @deprecated, @see, @returns)
//
// Output is capped per category so a chatty file doesn't dominate the
// LLM context budget.

const MAX_PER_CATEGORY_PER_FILE = 8;
const MAX_PER_CATEGORY_TOTAL = 40;
const MAX_LINE_TEXT = 240;

const MARKER_PATTERN =
  /\b(TODO|FIXME|HACK|XXX|NOTE|WARNING|DEPRECATED)\b[:\s-]?\s*(.*)$/;
const PROHIBITION_PATTERN =
  /\b(do not|don'?t|never|must not|avoid)\b/i;
const RATIONALE_PATTERN =
  /\b(because|reason|why|intentionally|on purpose|see [A-Z]|see #\d+|see docs|fixes|reverts|workaround)\b/i;
const JSDOC_TAG_PATTERN = /@(throws|throw|deprecated|see|returns|return|param|example|since|nosideeffects|sideeffects|todo|deprecated)\b/i;

function lineCommentText(line) {
  // Strip leading whitespace, then any of: // # /* */
  const trimmed = line.trim();
  let m;
  if ((m = trimmed.match(/^\/\/\s?(.*)$/))) return m[1];
  if ((m = trimmed.match(/^#\s?(.*)$/))) return m[1];
  if ((m = trimmed.match(/^\/\*+\s?(.*?)\s?\*+\/?\s*$/))) return m[1];
  if ((m = trimmed.match(/^\*\s?(.*)$/))) return m[1]; // continuation of block comment
  return null;
}

function isCommentLine(line) {
  return lineCommentText(line) !== null;
}

function clip(text) {
  if (!text) return "";
  return text.length > MAX_LINE_TEXT
    ? `${text.slice(0, MAX_LINE_TEXT)}…`
    : text;
}

function extractFromFile(file) {
  const lines = file.content.split("\n");
  const markers = [];
  const rationales = [];
  const prohibitions = [];
  const jsdocs = [];
  let header = null;

  // Capture the leading file-header block (continuous comment lines
  // from the very top of the file). Stops at the first non-comment line.
  if (lines.length > 0 && isCommentLine(lines[0])) {
    const headerLines = [];
    for (let i = 0; i < Math.min(lines.length, 20); i += 1) {
      const text = lineCommentText(lines[i]);
      if (text === null) break;
      headerLines.push(text);
    }
    const joined = headerLines.join(" ").trim();
    if (joined) header = { line: 1, text: clip(joined) };
  }

  // Walk every comment line, classify, capture.
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const text = lineCommentText(raw);
    if (text === null) continue;
    const lineNum = i + 1;

    // marker comments
    const markerMatch = text.match(MARKER_PATTERN);
    if (markerMatch) {
      const body = markerMatch[2]?.trim();
      if (body && body.length > 2 && markers.length < MAX_PER_CATEGORY_PER_FILE) {
        markers.push({
          line: lineNum,
          kind: markerMatch[1].toUpperCase(),
          text: clip(body)
        });
      }
      continue;
    }

    // JSDoc / PyDoc with @-tags
    if (JSDOC_TAG_PATTERN.test(text)) {
      if (jsdocs.length < MAX_PER_CATEGORY_PER_FILE) {
        jsdocs.push({ line: lineNum, text: clip(text.trim()) });
      }
      continue;
    }

    // Prohibition (do not / don't / never / must not)
    if (PROHIBITION_PATTERN.test(text)) {
      if (prohibitions.length < MAX_PER_CATEGORY_PER_FILE) {
        prohibitions.push({ line: lineNum, text: clip(text.trim()) });
      }
      continue;
    }

    // Rationale (why / because / see / intentionally)
    if (RATIONALE_PATTERN.test(text)) {
      if (rationales.length < MAX_PER_CATEGORY_PER_FILE) {
        rationales.push({ line: lineNum, text: clip(text.trim()) });
      }
      continue;
    }
  }

  return { header, markers, rationales, prohibitions, jsdocs };
}

function trimGlobal(items, max) {
  return items.slice(0, max);
}

function extractRichComments(sourceSample) {
  const samples = sourceSample?.samples || [];
  const headers = [];
  const markers = [];
  const rationales = [];
  const prohibitions = [];
  const jsdocs = [];

  for (const file of samples) {
    const r = extractFromFile(file);
    if (r.header) {
      headers.push({
        file: file.path,
        line: r.header.line,
        text: r.header.text
      });
    }
    for (const m of r.markers) markers.push({ file: file.path, ...m });
    for (const m of r.rationales) rationales.push({ file: file.path, ...m });
    for (const m of r.prohibitions) prohibitions.push({ file: file.path, ...m });
    for (const m of r.jsdocs) jsdocs.push({ file: file.path, ...m });
  }

  return {
    headers: trimGlobal(headers, MAX_PER_CATEGORY_TOTAL),
    markers: trimGlobal(markers, MAX_PER_CATEGORY_TOTAL),
    rationales: trimGlobal(rationales, MAX_PER_CATEGORY_TOTAL),
    prohibitions: trimGlobal(prohibitions, MAX_PER_CATEGORY_TOTAL),
    jsdocs: trimGlobal(jsdocs, MAX_PER_CATEGORY_TOTAL),
    summary: {
      header_count: headers.length,
      marker_count: markers.length,
      rationale_count: rationales.length,
      prohibition_count: prohibitions.length,
      jsdoc_count: jsdocs.length
    }
  };
}

export { extractRichComments, extractFromFile };
