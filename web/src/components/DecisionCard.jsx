export default function DecisionCard({ spec, summary, critique, audit }) {
  if (!spec) {
    return (
      <div className="card p-5">
        <h2 className="card-title">Decision</h2>
        <p className="mt-2 text-sm text-ink-400">Architecture decision not yet synthesized.</p>
      </div>
    );
  }
  const selected = spec.decision?.selected_topology;
  const isHumanReview = selected === "requires_human_architecture_review";
  const original = spec.decision?.original_selected_topology;
  const candidates = Array.isArray(spec.candidate_topologies) ? spec.candidate_topologies : [];
  const selectedCandidate =
    candidates.find((c) => c.name === selected) || candidates.find((c) => c.decision === "selected");
  const rejected = candidates.filter((c) => c.name !== selected);

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="card-title">Decision</h2>
        <span className={isHumanReview ? "pill-warn" : "pill-success"}>
          {spec.decision?.status || "proposed"}
        </span>
      </div>
      <div>
        <div className="text-2xl font-semibold tracking-tight text-ink-100">
          {selectedCandidate?.label || selected || "—"}
        </div>
        <div className="mt-1 font-mono text-xs text-ink-500">{selected}</div>
        {original && original !== selected && (
          <div className="mt-1 text-xs text-warn-500">
            Downgraded from <span className="font-mono">{original}</span> by critique
          </div>
        )}
      </div>
      {spec.decision?.summary && (
        <p className="text-sm leading-6 text-ink-200">{spec.decision.summary}</p>
      )}
      {selectedCandidate?.evidence_citations?.length > 0 && (
        <Citations citations={selectedCandidate.evidence_citations} />
      )}
      {rejected.length > 0 && (
        <div>
          <h3 className="card-title">Rejected alternatives</h3>
          <ul className="mt-2 space-y-3">
            {rejected.map((candidate) => (
              <li
                key={candidate.name}
                className="rounded-lg border border-ink-800 bg-ink-900/40 p-3"
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-medium text-ink-200">
                    {candidate.label || candidate.name}
                  </span>
                  <span className="font-mono text-xs text-ink-500">{candidate.decision}</span>
                </div>
                {candidate.fit && <p className="mt-1 text-xs text-ink-400">{candidate.fit}</p>}
                {Array.isArray(candidate.risks) && candidate.risks.length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-400">
                    {candidate.risks.slice(0, 4).map((risk, idx) => (
                      <li key={idx}>{risk}</li>
                    ))}
                  </ul>
                )}
                {candidate.evidence_citations?.length > 0 && (
                  <Citations citations={candidate.evidence_citations} />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(critique?.high_severity_count > 0 || (audit && audit.unsupported_count > 0)) && (
        <div className="rounded-md border border-warn-600/40 bg-warn-500/10 p-3 text-xs text-warn-500">
          {critique?.high_severity_count > 0 && (
            <div>
              {critique.high_severity_count} high-severity critique{" "}
              {critique.high_severity_count === 1 ? "issue" : "issues"} flagged.
            </div>
          )}
          {audit && audit.unsupported_count > 0 && (
            <div>
              {audit.unsupported_count}/{audit.total_citations} citations unsupported.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Citations({ citations }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-ink-400">
      <span className="text-ink-500">cites:</span>
      {citations.map((id) => (
        <span key={id} className="pill">
          [{id}]
        </span>
      ))}
    </div>
  );
}
