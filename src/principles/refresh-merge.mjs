// Merge logic for `adr principles refresh`. Given the prior principles
// artifact + the new consolidated principles, produce the merged set:
//
//  - Principles with overlapping evidence_cite to a prior principle inherit
//    the prior's confirmed_by_interview + confidence. The new rule/rationale
//    text wins (the new run saw fresher evidence), but the human's prior
//    confirmation transfers.
//
//  - Principles with no prior match are "genuinely new" — needs interview
//    confirmation. They start at the new run's confidence (typically
//    medium) and confirmed_by_interview: false.
//
// The match is based on filename-only overlap, not full file:line. A
// principle still ABOUT the same convention even after the team
// refactored should still match, even if the line number drifted.

function filenameOf(cite) {
  if (typeof cite !== "string") return null;
  const trimmed = cite.trim();
  if (!trimmed) return null;
  const [pathPart] = trimmed.split(":");
  return pathPart || null;
}

function filenameSetOf(cites) {
  const set = new Set();
  for (const cite of cites || []) {
    const fn = filenameOf(cite);
    if (fn) set.add(fn);
  }
  return set;
}

function citeOverlap(newCites, priorCites) {
  const newSet = filenameSetOf(newCites);
  const priorSet = filenameSetOf(priorCites);
  if (newSet.size === 0 || priorSet.size === 0) return 0;
  let shared = 0;
  for (const fn of newSet) if (priorSet.has(fn)) shared += 1;
  return shared;
}

function findPriorMatch(newPrinciple, priorPrinciples) {
  // First try exact ID match — the LLM may be stable enough that the same
  // convention gets the same slug across runs.
  const idMatch = priorPrinciples.find((p) => p.id === newPrinciple.id);
  if (idMatch) {
    return { prior: idMatch, reason: "exact_id_match" };
  }

  // Otherwise, find the prior with the most filename overlap. Require at
  // least 1 filename in common AND >=50% overlap with the new principle's
  // citations — otherwise we'd match wildly unrelated principles that
  // happen to share a single file.
  let bestPrior = null;
  let bestShared = 0;
  for (const prior of priorPrinciples) {
    const shared = citeOverlap(newPrinciple.evidence_cite, prior.evidence_cite);
    if (shared > bestShared) {
      bestShared = shared;
      bestPrior = prior;
    }
  }
  if (!bestPrior || bestShared < 1) return null;
  const newSize = filenameSetOf(newPrinciple.evidence_cite).size;
  if (newSize === 0) return null;
  if (bestShared / newSize < 0.5) return null;
  return { prior: bestPrior, reason: "cite_overlap" };
}

function mergePrinciples(newPrinciples, priorPrinciples) {
  const priorById = new Map(priorPrinciples.map((p) => [p.id, p]));
  const matchedPriorIds = new Set();
  const merged = [];
  const stats = {
    new: 0,
    inherited: 0,
    prior_total: priorPrinciples.length,
    dropped_from_prior: 0
  };

  for (const np of newPrinciples) {
    const match = findPriorMatch(np, priorPrinciples);
    if (!match) {
      merged.push({ ...np });
      stats.new += 1;
      continue;
    }
    matchedPriorIds.add(match.prior.id);
    merged.push({
      ...np,
      // Inherit confirmation status — the user already said yes/no to this
      // convention. Don't bother them again.
      confirmed_by_interview: Boolean(match.prior.confirmed_by_interview),
      // Confidence carries forward when the prior was confirmed; otherwise
      // take the higher of the two. Sliding down from "high" because the
      // evidence reshuffled would surprise the user.
      confidence: pickConfidence(np.confidence, match.prior.confidence),
      __prior_match: { reason: match.reason, prior_id: match.prior.id }
    });
    stats.inherited += 1;
  }

  for (const p of priorPrinciples) {
    if (!matchedPriorIds.has(p.id)) stats.dropped_from_prior += 1;
  }

  // The __prior_match shape is internal — used by the interview generator
  // to know which principles are new and need confirmation. Strip before
  // persisting.
  const persisted = merged.map((p) => {
    const { __prior_match, ...rest } = p;
    return rest;
  });

  return { merged: persisted, mergedInternal: merged, stats };
}

function pickConfidence(newConf, priorConf) {
  const order = { low: 0, medium: 1, high: 2 };
  const a = order[newConf] ?? 1;
  const b = order[priorConf] ?? 1;
  const max = Math.max(a, b);
  return Object.keys(order).find((k) => order[k] === max) || "medium";
}

// Partition new principles into "needs interview" vs "auto-confirmed by
// prior". The interview generator only needs to ask about needs-interview.
function partitionForInterview(mergedInternal) {
  const needsInterview = [];
  const autoConfirmed = [];
  for (const p of mergedInternal) {
    if (p.__prior_match) autoConfirmed.push(p);
    else needsInterview.push(p);
  }
  return { needsInterview, autoConfirmed };
}

export {
  mergePrinciples,
  partitionForInterview,
  findPriorMatch,
  citeOverlap,
  filenameOf,
  filenameSetOf
};
