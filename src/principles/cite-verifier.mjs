import { stat } from "node:fs/promises";
import path from "node:path";

// Parse a citation of shape `path/to/file.ext:42` or `path/to/file.ext`.
// Returns { path, line } or null if unparseable.
function parseCite(cite) {
  if (typeof cite !== "string") return null;
  const trimmed = cite.trim();
  if (!trimmed) return null;
  const colonMatch = trimmed.match(/^(.+?):(\d+)(?:-\d+)?$/);
  if (colonMatch) {
    return { path: colonMatch[1].trim(), line: Number(colonMatch[2]) };
  }
  return { path: trimmed, line: null };
}

async function pathExists(absPath) {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

// Verify each citation points at a file that actually exists on disk under
// `repoPath`. Returns { kept, dropped } so callers can log how many bogus
// citations were stripped (cheap fabrication signal).
async function verifyCitations(cites, repoPath) {
  const kept = [];
  const dropped = [];
  const seen = new Set();
  for (const raw of cites) {
    const parsed = parseCite(raw);
    if (!parsed) {
      dropped.push(raw);
      continue;
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    const absPath = path.resolve(repoPath, parsed.path);
    if (await pathExists(absPath)) {
      kept.push(raw);
    } else {
      dropped.push(raw);
    }
  }
  return { kept, dropped };
}

// Apply cite-or-die to the final principle set. Drops any principle whose
// evidence_cite has zero verified citations after filtering. Returns the
// pruned list plus a summary suitable for the events.jsonl log.
async function pruneFabricatedCitations(principles, repoPath) {
  const summary = {
    principles_in: principles.length,
    citations_dropped: 0,
    examples_dropped: 0,
    principles_pruned: 0
  };

  const pruned = [];
  for (const p of principles) {
    const ev = await verifyCitations(p.evidence_cite || [], repoPath);
    summary.citations_dropped += ev.dropped.length;
    const follow = await verifyCitations(p.examples_to_follow || [], repoPath);
    summary.examples_dropped += follow.dropped.length;
    const avoid = await verifyCitations(p.examples_to_avoid || [], repoPath);
    summary.examples_dropped += avoid.dropped.length;

    if (ev.kept.length === 0) {
      summary.principles_pruned += 1;
      continue;
    }

    pruned.push({
      ...p,
      evidence_cite: ev.kept,
      examples_to_follow: follow.kept,
      examples_to_avoid: avoid.kept
    });
  }

  summary.principles_out = pruned.length;
  return { principles: pruned, summary };
}

export { pruneFabricatedCitations, verifyCitations, parseCite };
