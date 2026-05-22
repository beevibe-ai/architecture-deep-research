import { Link } from "react-router-dom";
import { listRuns } from "../lib/api.js";
import { usePolling } from "../lib/usePolling.js";
import StatusPill from "../components/StatusPill.jsx";

export default function RunsIndex() {
  const { data, error, loading } = usePolling(listRuns, { interval: 5000 });
  const runs = data?.runs || [];

  return (
    <section className="space-y-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Runs</h1>
        <p className="text-xs text-ink-500">
          Polling every 5s. Newest first. State derived from <code className="kbd">state.json</code>.
        </p>
      </header>

      {error && (
        <div className="card p-4 text-sm text-danger-500">
          Failed to load runs: {String(error.message || error)}
        </div>
      )}

      {!error && loading && (
        <div className="card p-4 text-sm text-ink-400">Loading runs…</div>
      )}

      {!loading && runs.length === 0 && (
        <div className="card flex flex-col items-start gap-3 p-6">
          <p className="text-sm text-ink-300">No runs found yet.</p>
          <p className="text-xs text-ink-500">
            Start a run via <code className="kbd">npm run adr -- deep-research ...</code>,{" "}
            <code className="kbd">npm run adr:langgraph</code>, <code className="kbd">npm run adr:adk</code>,
            or use the <Link to="/new" className="link">+ New run</Link> form.
          </p>
        </div>
      )}

      {runs.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-ink-800">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Architecture Deep Research runs, newest first; click a row to open it.
            </caption>
            <thead className="bg-ink-900/60 text-xs uppercase tracking-wide text-ink-400">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">Run</th>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">Status</th>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">Topology</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Evidence</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Promoted</th>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800 bg-ink-950/40">
              {runs.map((run) => (
                <tr key={run.id} className="hover:bg-ink-900/40">
                  <td className="px-4 py-2.5 font-mono text-xs">
                    <Link to={`/runs/${encodeURIComponent(run.id)}`} className="link">
                      {run.id}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusPill status={run.status} />
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-300">
                    {run.selected_topology || <span className="text-ink-600">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {run.evidence_count ?? <span className="text-ink-600">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {run.promoted_candidate_count ?? <span className="text-ink-600">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-ink-400">
                    {run.completed_at || run.modified_at || ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
