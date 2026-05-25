import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const STATS_FILE = "principle-stats.json";
const RECENT_WINDOW = 20;

// Load the persisted stats file. Returns the artifact shape (or empty if
// missing). Stats live next to principles.json so they share a directory
// with the rules they describe.
async function loadStats(principlesDir) {
  try {
    const raw = await readFile(path.join(principlesDir, STATS_FILE), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function emptyStats() {
  return {
    version: 1,
    last_updated: null,
    by_principle: {}
  };
}

function ensurePrincipleSlot(stats, principleId, nowIsoString) {
  if (!stats.by_principle[principleId]) {
    stats.by_principle[principleId] = {
      principle_id: principleId,
      total_seen: 0,
      accepted: 0,
      edited: 0,
      skipped: 0,
      first_seen_at: nowIsoString,
      last_seen_at: nowIsoString,
      recent_outcomes: []
    };
  }
  return stats.by_principle[principleId];
}

// Apply a batch of outcomes from one `adr review` run to the stats.
// outcomes: [{ principle_id, outcome: 'accepted' | 'edited' | 'skipped' }]
function applyOutcomes(stats, outcomes, nowIsoString) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return stats;
  for (const o of outcomes) {
    if (!o || typeof o.principle_id !== "string") continue;
    if (!["accepted", "edited", "skipped"].includes(o.outcome)) continue;
    const slot = ensurePrincipleSlot(stats, o.principle_id, nowIsoString);
    slot.total_seen += 1;
    slot[o.outcome] += 1;
    slot.last_seen_at = nowIsoString;
    slot.recent_outcomes.push(o.outcome);
    if (slot.recent_outcomes.length > RECENT_WINDOW) {
      slot.recent_outcomes = slot.recent_outcomes.slice(-RECENT_WINDOW);
    }
  }
  stats.last_updated = nowIsoString;
  return stats;
}

async function saveStats(principlesDir, stats) {
  await writeFile(
    path.join(principlesDir, STATS_FILE),
    `${JSON.stringify(stats, null, 2)}\n`
  );
}

// Convenience: load → apply → save in one call. Returns the updated stats.
async function recordOutcomes(principlesDir, outcomes, nowIsoString) {
  const current = (await loadStats(principlesDir)) || emptyStats();
  const next = applyOutcomes(current, outcomes, nowIsoString);
  await saveStats(principlesDir, next);
  return next;
}

// Compute aggregate signals for one principle. Used by #5 (confidence
// auto-evolves) and surfaceable in slash commands.
function summarizePrinciple(stats, principleId, { recentWindow = 10 } = {}) {
  const slot = stats?.by_principle?.[principleId];
  if (!slot) return null;
  const recent = slot.recent_outcomes.slice(-recentWindow);
  const recentSkipped = recent.filter((o) => o === "skipped").length;
  const recentEdited = recent.filter((o) => o === "edited").length;
  const recentAccepted = recent.filter((o) => o === "accepted").length;
  const total = slot.total_seen;
  return {
    principle_id: principleId,
    total_seen: total,
    overall_skip_rate: total > 0 ? slot.skipped / total : 0,
    overall_accept_rate: total > 0 ? slot.accepted / total : 0,
    overall_edit_rate: total > 0 ? slot.edited / total : 0,
    recent_window: recent.length,
    recent_skip_rate: recent.length > 0 ? recentSkipped / recent.length : 0,
    recent_edit_rate: recent.length > 0 ? recentEdited / recent.length : 0,
    recent_accept_rate: recent.length > 0 ? recentAccepted / recent.length : 0
  };
}

export {
  loadStats,
  saveStats,
  applyOutcomes,
  recordOutcomes,
  summarizePrinciple,
  emptyStats,
  STATS_FILE,
  RECENT_WINDOW
};
