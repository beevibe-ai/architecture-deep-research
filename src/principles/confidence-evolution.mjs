// Confidence evolution — read principle-stats.json (built by `adr review`)
// and override each principle's confidence based on how the team actually
// uses it. Runs on every `adr principles init` and `adr principles refresh`.
//
// Rules:
//   - need at least MIN_DATAPOINTS observations to make any move
//   - recent_skip_rate >= SKIP_DEMOTE_THRESHOLD → confidence: low
//     (the team keeps saying "this isn't actually a rule")
//   - recent_accept_rate >= ACCEPT_PROMOTE_THRESHOLD → confidence: high
//     (the team keeps confirming it)
//   - otherwise: leave confidence as whatever discovery + interview gave us
//
// Why this fights the static-linting trap: a principle that fires 20
// times and gets skipped 18 times is wrong. With static lint, it stays a
// rule forever. With this loop, it auto-demotes within a few weeks, and
// the next refresh surfaces it for re-confirmation or removal.

import { readFile } from "node:fs/promises";
import path from "node:path";

const MIN_DATAPOINTS = 5;
const SKIP_DEMOTE_THRESHOLD = 0.5;
const ACCEPT_PROMOTE_THRESHOLD = 0.8;
const RECENT_WINDOW = 10;

async function loadStatsForEvolution(principlesDir) {
  try {
    const raw = await readFile(
      path.join(principlesDir, "principle-stats.json"),
      "utf8"
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function recentRates(slot) {
  const recent = slot.recent_outcomes.slice(-RECENT_WINDOW);
  if (recent.length === 0) return { skip: 0, accept: 0, edit: 0, n: 0 };
  const skip = recent.filter((o) => o === "skipped").length;
  const accept = recent.filter((o) => o === "accepted").length;
  const edit = recent.filter((o) => o === "edited").length;
  return {
    n: recent.length,
    skip: skip / recent.length,
    accept: accept / recent.length,
    edit: edit / recent.length
  };
}

function evolveOne(principle, slot) {
  if (!slot || slot.total_seen < MIN_DATAPOINTS) {
    return { principle, change: null };
  }
  const rates = recentRates(slot);
  const before = principle.confidence;
  let after = before;
  let reason = null;

  if (rates.skip >= SKIP_DEMOTE_THRESHOLD) {
    after = "low";
    reason = `skip_rate=${rates.skip.toFixed(2)} on ${rates.n} recent runs`;
  } else if (rates.accept >= ACCEPT_PROMOTE_THRESHOLD) {
    after = "high";
    reason = `accept_rate=${rates.accept.toFixed(2)} on ${rates.n} recent runs`;
  }

  if (after === before) return { principle, change: null };

  return {
    principle: { ...principle, confidence: after },
    change: {
      principle_id: principle.id,
      from: before,
      to: after,
      reason,
      total_seen: slot.total_seen
    }
  };
}

function applyStatsToConfidence(principles, stats) {
  if (!stats || !stats.by_principle) {
    return { principles, changes: [] };
  }
  const evolved = [];
  const changes = [];
  for (const p of principles) {
    const slot = stats.by_principle[p.id];
    const result = evolveOne(p, slot);
    evolved.push(result.principle);
    if (result.change) changes.push(result.change);
  }
  return { principles: evolved, changes };
}

export {
  applyStatsToConfidence,
  loadStatsForEvolution,
  MIN_DATAPOINTS,
  SKIP_DEMOTE_THRESHOLD,
  ACCEPT_PROMOTE_THRESHOLD,
  RECENT_WINDOW
};
