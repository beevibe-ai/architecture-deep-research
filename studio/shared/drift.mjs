// Drift — the canvas stops being a fiction.
//
// A diagram rots the moment you write code: the boxes say one thing, the repo
// does another. `diffArchitecture` compares the architecture you DREW (the
// designed spec) against the architecture INFERRED from the real repo (the
// actual spec) and reports where they diverge — with file-level evidence, the
// same cite-or-die discipline the research engine uses.
//
// Three kinds of drift:
//   - in_code_not_designed : the repo has it, your diagram doesn't (you forgot
//     to draw it, or it crept in). The most valuable signal.
//   - designed_not_in_code : you drew it, the repo has no trace (aspirational,
//     not built yet, or removed).
//   - tech_mismatch        : matched component, different technology (design
//     says Postgres, the code imports mysql2).
//
// Pure and deterministic — no I/O, no clock. The host computes it; the webview
// renders it; tests construct real specs and assert on the report.

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Top-level components only — nested internals (a runtime's State Manager etc.)
// are an implementation detail of one box, not separate architecture.
function topLevel(view) {
  return (view?.nodes || []).filter((n) => !n.parent);
}

// Evidence the inference attached to an actual node: which repo files grounded
// the claim. We read it from `notes` first (where the inference is told to put
// the cite), then `context`, then any explicit `evidence` array.
function evidenceOf(node) {
  if (Array.isArray(node.evidence)) return node.evidence;
  const raw = node.notes || node.context || "";
  if (!raw) return [];
  // Accept "path/a.ts, path/b.ts" or a sentence that mentions paths.
  const cites = String(raw).match(/[\w./-]+\.[a-z]{1,5}(:\d+)?/gi);
  return cites ? [...new Set(cites)] : [];
}

function techDiffers(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false; // one side unknown — not a mismatch, just thin
  return na !== nb && !na.includes(nb) && !nb.includes(na);
}

// Match designed ↔ actual nodes. Two passes: exact normalized-label match
// first (most specific), then same catalog `type` among the leftovers. Greedy
// and order-stable so the report is deterministic.
function matchNodes(designed, actual) {
  const matched = [];
  const dLeft = designed.map((n, i) => ({ n, i, used: false }));
  const aLeft = actual.map((n, i) => ({ n, i, used: false }));

  const pass = (eq) => {
    for (const d of dLeft) {
      if (d.used) continue;
      const a = aLeft.find((x) => !x.used && eq(d.n, x.n));
      if (a) {
        d.used = true;
        a.used = true;
        matched.push({ designed: d.n, actual: a.n });
      }
    }
  };
  pass((d, a) => norm(d.label) === norm(a.label));
  pass((d, a) => d.type && a.type && d.type === a.type);

  return {
    matched,
    designedOnly: dLeft.filter((d) => !d.used).map((d) => d.n),
    actualOnly: aLeft.filter((a) => !a.used).map((a) => a.n),
  };
}

export function diffArchitecture(designedView, actualView) {
  const designed = topLevel(designedView);
  const actual = topLevel(actualView);
  const { matched, designedOnly, actualOnly } = matchNodes(designed, actual);

  const in_code_not_designed = actualOnly.map((n) => ({
    label: n.label,
    type: n.type,
    tech: n.tech || "",
    evidence: evidenceOf(n),
  }));

  const designed_not_in_code = designedOnly.map((n) => ({
    id: n.id,
    label: n.label,
    type: n.type,
    tech: n.tech || "",
  }));

  const tech_mismatch = matched
    .filter((m) => techDiffers(m.designed.tech, m.actual.tech))
    .map((m) => ({
      id: m.designed.id,
      label: m.designed.label,
      designed_tech: m.designed.tech || "",
      actual_tech: m.actual.tech || "",
      evidence: evidenceOf(m.actual),
    }));

  const in_sync =
    in_code_not_designed.length === 0 &&
    designed_not_in_code.length === 0 &&
    tech_mismatch.length === 0;

  return {
    summary: {
      designed_count: designed.length,
      actual_count: actual.length,
      matched: matched.length,
      in_code_not_designed: in_code_not_designed.length,
      designed_not_in_code: designed_not_in_code.length,
      tech_mismatch: tech_mismatch.length,
      in_sync,
    },
    in_code_not_designed,
    designed_not_in_code,
    tech_mismatch,
  };
}

// Per-node drift status, keyed by designed-node id, for coloring the canvas.
// "matched" nodes that have a tech mismatch are flagged "mismatch"; designed
// nodes with no counterpart in code are "phantom".
export function driftStatusByNode(designedView, actualView) {
  const report = diffArchitecture(designedView, actualView);
  const status = {};
  for (const m of report.designed_not_in_code) status[m.id] = "phantom";
  for (const m of report.tech_mismatch) status[m.id] = "mismatch";
  return status;
}
