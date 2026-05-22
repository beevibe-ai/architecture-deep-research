const VERDICT_CLASS = {
  strong: "matrix-strong",
  mixed: "matrix-mixed",
  weak: "matrix-weak",
  no_evidence: "matrix-empty"
};

export default function ComparisonMatrix({ matrix }) {
  const axes = matrix?.axes || [];
  const candidates = matrix?.candidates || [];
  const cells = matrix?.cells || [];
  if (axes.length === 0 || candidates.length === 0) return null;

  const cellMap = new Map();
  for (const cell of cells) {
    cellMap.set(`${cell.candidate}|${cell.axis}`, cell);
  }

  return (
    <div className="card p-5 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="card-title">Comparison matrix</h2>
        <div className="flex items-center gap-3 text-xs text-ink-500">
          <Legend />
        </div>
      </div>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-[40rem] border-separate border-spacing-2">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-ink-900/0 px-2 py-1 text-left text-xs uppercase tracking-wide text-ink-500">
                Axis
              </th>
              {candidates.map((candidate) => (
                <th
                  key={candidate.name}
                  className="px-2 py-1 text-left text-xs font-medium text-ink-300"
                >
                  <div>{candidate.label || candidate.name}</div>
                  <div className="font-mono text-2xs text-ink-500">
                    {candidate.promotion_status}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {axes.map((axis) => (
              <tr key={axis.id}>
                <th className="px-2 py-1 text-left text-xs font-normal text-ink-400">
                  <div className="font-medium text-ink-200">{axis.label}</div>
                  {axis.rationale && (
                    <div className="font-mono text-2xs text-ink-500">{axis.rationale}</div>
                  )}
                </th>
                {candidates.map((candidate) => {
                  const cell = cellMap.get(`${candidate.name}|${axis.id}`);
                  const verdict = cell?.verdict || "no_evidence";
                  const cls = VERDICT_CLASS[verdict] || "matrix-empty";
                  return (
                    <td key={candidate.name} className="align-top">
                      <div className={cls}>
                        <div className="font-mono text-2xs uppercase tracking-wide">
                          {verdict}
                        </div>
                        {cell?.summary && (
                          <div className="mt-0.5 text-ink-200">{cell.summary}</div>
                        )}
                        {cell?.evidence_citations?.length > 0 && (
                          <div className="mt-0.5 text-2xs text-ink-400">
                            cites {cell.evidence_citations.map((id) => `[${id}]`).join(" ")}
                          </div>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {Array.isArray(matrix.adversarial_queries_run) && matrix.adversarial_queries_run.length > 0 && (
        <div className="text-xs text-ink-500">
          Adversarial queries run:{" "}
          {matrix.adversarial_queries_run.slice(0, 6).map((q, i) => (
            <code key={i} className="kbd ml-1">
              {q}
            </code>
          ))}
          {matrix.adversarial_queries_run.length > 6 && " …"}
        </div>
      )}
    </div>
  );
}

function Legend() {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="matrix-strong px-1.5 py-0.5">strong</span>
      <span className="matrix-mixed px-1.5 py-0.5">mixed</span>
      <span className="matrix-weak px-1.5 py-0.5">weak</span>
      <span className="matrix-empty px-1.5 py-0.5">no_evidence</span>
    </span>
  );
}
