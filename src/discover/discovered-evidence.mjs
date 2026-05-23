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
  }
  return items;
}

export { discoveredEvidenceItems, SYNTHETIC_TASK_ID };
