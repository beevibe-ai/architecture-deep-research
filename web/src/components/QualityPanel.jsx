export default function QualityPanel({ summary, critique, audit, claimAudit, matrix }) {
  const cells = matrix?.cells || [];
  const emptyCount = matrix?.empty_cells?.length || 0;
  const strongCount = cells.filter((c) => c.verdict === "strong").length;
  const weakCount = cells.filter((c) => c.verdict === "weak").length;
  const totalCells = cells.length;

  return (
    <div className="card p-4 space-y-3">
      <h2 className="card-title">Run quality</h2>
      <dl className="space-y-2 text-sm">
        <Row label="Evidence items" value={summary?.evidence_count ?? "—"} />
        <Row label="Promoted candidates" value={summary?.promoted_candidate_count ?? "—"} />
        {matrix && (
          <>
            <Row label="Matrix cells" value={totalCells} />
            <Row label="Strong cells" value={strongCount} tone="success" />
            <Row label="Weak cells" value={weakCount} tone="danger" />
            <Row label="Empty cells" value={emptyCount} tone="warn" />
          </>
        )}
        {critique && (
          <>
            <Row label="Critique issues" value={critique.issues?.length || 0} />
            <Row
              label="High-severity issues"
              value={critique.high_severity_count || 0}
              tone={critique.high_severity_count > 0 ? "danger" : "success"}
            />
            <Row
              label="Recommend human review"
              value={critique.recommend_human_review ? "yes" : "no"}
              tone={critique.recommend_human_review ? "warn" : "success"}
            />
          </>
        )}
        {audit && (
          <>
            <Row label="Citations verified" value={`${audit.verified_count} / ${audit.total_citations}`} />
            <Row
              label="Citations unsupported"
              value={audit.unsupported_count}
              tone={audit.unsupported_count > 0 ? "danger" : "success"}
            />
          </>
        )}
        {claimAudit && (
          <>
            <Row label="Claims checked" value={claimAudit.total_claims_checked || 0} />
            <Row
              label="Uncited material claims"
              value={claimAudit.uncited_material_claim_count || 0}
              tone={claimAudit.uncited_material_claim_count > 0 ? "warn" : "success"}
            />
            <Row
              label="High-severity claim gaps"
              value={claimAudit.high_severity_count || 0}
              tone={claimAudit.high_severity_count > 0 ? "danger" : "success"}
            />
          </>
        )}
      </dl>
    </div>
  );
}

const TONE_CLASS = {
  success: "text-success-500",
  warn: "text-warn-500",
  danger: "text-danger-500"
};

function Row({ label, value, tone }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className={`font-mono text-sm ${tone ? TONE_CLASS[tone] : "text-ink-200"}`}>{value}</dd>
    </div>
  );
}
