// Converts discovered patterns/anti-patterns into private_corpus evidence
// items the rest of the kernel can consume. Only items that carry an
// architecture_family field produce evidence — others stay as principles
// only (still informational, but they do not vote in the knowledge map).
//
// The synthetic items match the existing evidence.json schema so they pass
// validation alongside live-research items. Their source_type is
// "private_corpus", which the knowledge-map promotion gate already accepts.

const SYNTHETIC_TASK_ID = "discover_synthetic_private_corpus";
const SYNTHETIC_SOURCE_QUALITY = 0.75;
const SYNTHETIC_SCORE_BASE = 0.7;
const SYNTHETIC_CONFIDENCE = 0.8;

function privateUrl(item) {
  const first = (item.evidence_cite && item.evidence_cite[0]) || item.name;
  return `private://${first}`;
}

function nowIso() {
  return new Date().toISOString();
}

function patternEvidenceItem(pattern, index) {
  return {
    citation_id: index, // reassigned by caller via assignCitations
    task_id: SYNTHETIC_TASK_ID,
    title: `Team pattern: ${pattern.name}`,
    url: privateUrl(pattern),
    query: "discover_synthetic_private_corpus",
    provider: "discover",
    excerpt:
      pattern.description ||
      `Team already follows pattern '${pattern.name}'. Cited: ${pattern.evidence_cite.join(", ")}.`,
    source_type: "private_corpus",
    source_quality: SYNTHETIC_SOURCE_QUALITY,
    retrieved_at: nowIso(),
    fetch_status: "synthetic_from_discover",
    content_hash: `discover-pattern:${pattern.name}`,
    raw_text_path: null,
    raw_text_bytes: 0,
    keyword_hits: pattern.evidence_cite,
    score: SYNTHETIC_SCORE_BASE,
    relevance: "Team-internal pattern surfaced by adr discover.",
    claims: [
      {
        claim: `Team already follows '${pattern.name}'${
          pattern.description ? ` — ${pattern.description}` : ""
        }. Cited: ${pattern.evidence_cite.join(", ")}.`,
        architecture_family: pattern.architecture_family,
        polarity: "supports",
        risk_or_fit:
          "Compatible with team's existing patterns; lower migration cost.",
        confidence: SYNTHETIC_CONFIDENCE
      }
    ]
  };
}

function antipatternEvidenceItem(ap, index) {
  return {
    citation_id: index,
    task_id: SYNTHETIC_TASK_ID,
    title: `Team antipattern: ${ap.name}`,
    url: privateUrl(ap),
    query: "discover_synthetic_private_corpus",
    provider: "discover",
    excerpt:
      ap.reason ||
      `Team has explicitly rejected '${ap.name}'. Cited: ${ap.evidence_cite.join(", ")}.`,
    source_type: "private_corpus",
    source_quality: SYNTHETIC_SOURCE_QUALITY,
    retrieved_at: nowIso(),
    fetch_status: "synthetic_from_discover",
    content_hash: `discover-antipattern:${ap.name}`,
    raw_text_path: null,
    raw_text_bytes: 0,
    keyword_hits: ap.evidence_cite,
    score: SYNTHETIC_SCORE_BASE,
    relevance: "Team-internal antipattern surfaced by adr discover.",
    claims: [
      {
        claim: `Team has rejected '${ap.name}'${
          ap.reason ? ` — ${ap.reason}` : ""
        }. Cited: ${ap.evidence_cite.join(", ")}.`,
        architecture_family: ap.architecture_family,
        polarity: "rejects",
        risk_or_fit:
          "Conflicts with team's explicit rejection; high coordination cost to overturn.",
        confidence: SYNTHETIC_CONFIDENCE
      }
    ]
  };
}

// Build a synthetic opposing evidence item: same source provenance as the
// supporting pattern/antipattern that produced it, but with architecture_family
// pointing at the OPPOSED family and polarity: "rejects". This is how
// "team already uses pgvector" becomes opposing evidence against pinecone /
// weaviate candidates in the matrix, not just supporting evidence for pgvector.
function opposingEvidenceItem({ kind, source, opposedFamily, index }) {
  const sourceName = source.name;
  const sourceFamily = source.architecture_family;
  const isPattern = kind === "pattern";
  return {
    citation_id: index,
    task_id: SYNTHETIC_TASK_ID,
    title: isPattern
      ? `Team pattern '${sourceName}' opposes ${opposedFamily}`
      : `Team antipattern '${sourceName}' opposes ${opposedFamily}`,
    url: `${privateUrl(source)}#opposes-${opposedFamily}`,
    query: "discover_synthetic_private_corpus",
    provider: "discover",
    excerpt: isPattern
      ? `Team's '${sourceName}' pattern (architecture_family: ${sourceFamily}) conflicts with '${opposedFamily}' — these are alternatives in the same decision space. Cited: ${source.evidence_cite.join(", ")}.`
      : `Team's rejection of '${sourceName}' (architecture_family: ${sourceFamily}) also weighs against '${opposedFamily}' for the same reasons. Cited: ${source.evidence_cite.join(", ")}.`,
    source_type: "private_corpus",
    source_quality: SYNTHETIC_SOURCE_QUALITY,
    retrieved_at: nowIso(),
    fetch_status: "synthetic_from_discover",
    content_hash: `discover-${kind}-opposes:${sourceName}:${opposedFamily}`,
    raw_text_path: null,
    raw_text_bytes: 0,
    keyword_hits: source.evidence_cite,
    score: SYNTHETIC_SCORE_BASE,
    relevance: `Discover-derived opposing claim: '${sourceName}' conflicts with '${opposedFamily}'.`,
    claims: [
      {
        claim: isPattern
          ? `Adopting '${opposedFamily}' would conflict with team's existing pattern '${sourceName}' (architecture_family: ${sourceFamily}). Migration cost + coordination cost.`
          : `Adopting '${opposedFamily}' shares the same failure mode that led the team to reject '${sourceName}' (architecture_family: ${sourceFamily}).`,
        architecture_family: opposedFamily,
        polarity: "rejects",
        risk_or_fit: isPattern
          ? "Conflicts with team's adopted pattern; introduces migration + coordination cost."
          : "Repeats the failure mode the team previously rejected.",
        confidence: SYNTHETIC_CONFIDENCE * 0.85
      }
    ]
  };
}

function discoveredEvidenceItems(discoveredPrinciples) {
  if (!discoveredPrinciples || typeof discoveredPrinciples !== "object") {
    return [];
  }
  const items = [];
  let cursor = 1;
  for (const pattern of discoveredPrinciples.patterns || []) {
    if (
      !pattern.architecture_family ||
      typeof pattern.architecture_family !== "string" ||
      !pattern.architecture_family.trim()
    ) {
      continue;
    }
    if (!Array.isArray(pattern.evidence_cite) || pattern.evidence_cite.length === 0) {
      continue;
    }
    items.push(patternEvidenceItem(pattern, cursor));
    cursor += 1;

    // Bidirectional: emit one opposing item per opposes_families entry.
    // The opposed family must differ from the pattern's own architecture_family
    // (a pattern can't oppose itself). De-dup within this pattern.
    const opposed = (pattern.opposes_families || []).filter(
      (fam) => typeof fam === "string" && fam.trim() && fam.trim() !== pattern.architecture_family.trim()
    );
    const seen = new Set();
    for (const fam of opposed) {
      const key = fam.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(opposingEvidenceItem({
        kind: "pattern",
        source: pattern,
        opposedFamily: key,
        index: cursor
      }));
      cursor += 1;
    }
  }
  for (const ap of discoveredPrinciples.antipatterns || []) {
    if (
      !ap.architecture_family ||
      typeof ap.architecture_family !== "string" ||
      !ap.architecture_family.trim()
    ) {
      continue;
    }
    if (!Array.isArray(ap.evidence_cite) || ap.evidence_cite.length === 0) {
      continue;
    }
    items.push(antipatternEvidenceItem(ap, cursor));
    cursor += 1;

    // Antipatterns can also have opposes_families (e.g. team rejected
    // microservices → opposes service_mesh too). Same dedup rule.
    const opposed = (ap.opposes_families || []).filter(
      (fam) => typeof fam === "string" && fam.trim() && fam.trim() !== ap.architecture_family.trim()
    );
    const seen = new Set();
    for (const fam of opposed) {
      const key = fam.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(opposingEvidenceItem({
        kind: "antipattern",
        source: ap,
        opposedFamily: key,
        index: cursor
      }));
      cursor += 1;
    }
  }
  return items;
}

export { discoveredEvidenceItems, SYNTHETIC_TASK_ID };
