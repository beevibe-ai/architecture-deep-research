const SOURCE_TYPE_PILL = {
  official_docs: "pill-success",
  mature_oss: "pill-info",
  paper_or_benchmark: "pill-info",
  engineering_writeup: "pill-warn",
  general_web: "pill",
  unknown: "pill"
};

export default function EvidencePanel({ evidence, knowledgeMap }) {
  const candidates =
    knowledgeMap?.candidates || knowledgeMap?.promoted_candidates || [];
  const offTopic =
    knowledgeMap?.off_topic_candidates ||
    knowledgeMap?.insufficient_evidence_candidates ||
    [];
  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="card-title">Evidence</h2>
        <div className="text-xs text-ink-500">
          {evidence.length} items · {candidates.length} candidates, {offTopic.length} off-topic
        </div>
      </div>
      {(candidates.length > 0 || offTopic.length > 0) && (
        <div className="rounded-lg border border-ink-800 bg-ink-900/30 p-3 text-xs">
          {candidates.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ink-400">Candidates:</span>
              {candidates.map((p) => (
                <span key={p.name} className="pill-success">
                  {p.label} · {p.evidence_depth || "thin"} · {p.evidence_count}
                </span>
              ))}
            </div>
          )}
          {offTopic.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-ink-400">Off-topic:</span>
              {offTopic.map((p) => (
                <span key={p.name} className="pill-warn">
                  {p.label} · {p.evidence_count}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <ul className="divide-y divide-ink-800">
        {evidence.map((item) => (
          <li key={`${item.citation_id}|${item.url}`} className="py-3">
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link block truncate text-sm font-medium"
                >
                  [{item.citation_id}] {item.title}
                </a>
                <div className="mt-0.5 truncate font-mono text-2xs text-ink-500">{item.url}</div>
              </div>
              <span className={SOURCE_TYPE_PILL[item.source_type] || "pill"}>
                {item.source_type}
              </span>
            </div>
            {item.repo_digest && (
              <div className="mt-1 text-xs text-ink-400">
                <span className="font-mono">repo</span>: {item.repo_digest.stars}★ · last push{" "}
                {item.repo_digest.last_pushed_at} ·{" "}
                {item.repo_digest.archived ? "archived" : "active"} ·{" "}
                {item.repo_digest.failure_mode_issues?.length || 0} failure-mode issues
              </div>
            )}
            {item.paper_digest && (
              <div className="mt-1 text-xs text-ink-400">
                <span className="font-mono">paper</span>:{" "}
                {item.paper_digest.measured_results?.length || 0} measured results ·{" "}
                {item.paper_digest.limitations?.length || 0} limitations
              </div>
            )}
            {Array.isArray(item.claims) && item.claims.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-ink-300">
                {item.claims.slice(0, 3).map((claim, idx) => (
                  <li key={idx} className="flex items-baseline gap-2">
                    <span
                      className={
                        claim.polarity === "supports"
                          ? "text-success-500"
                          : claim.polarity === "rejects"
                            ? "text-danger-500"
                            : "text-ink-400"
                      }
                    >
                      {claim.polarity || "neutral"}
                    </span>
                    <span className="text-ink-200">{claim.claim}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
