import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getArtifact, getRun, subscribeEvents } from "../lib/api.js";
import { usePolling } from "../lib/usePolling.js";
import OperatorView from "./OperatorView.jsx";
import DeveloperView from "./DeveloperView.jsx";
import StatusPill from "../components/StatusPill.jsx";

const TERMINAL_STATUSES = new Set([
  "completed",
  "aborted_by_human",
  "needs_clarification",
  "failed"
]);

export default function RunDetail() {
  const { id } = useParams();
  const [mode, setMode] = useState("operator");
  const [pollingPaused, setPollingPaused] = useState(false);
  const { data: summary, error: summaryError, loading } = usePolling(
    () => getRun(id),
    { interval: 4000, enabled: !pollingPaused, deps: [id] }
  );

  // Suspend polling once the run reaches a terminal status — there's nothing
  // more to refresh, and 4s polls would otherwise continue forever.
  useEffect(() => {
    if (summary?.status && TERMINAL_STATUSES.has(summary.status)) {
      setPollingPaused(true);
    } else if (pollingPaused && summary?.status && !TERMINAL_STATUSES.has(summary.status)) {
      setPollingPaused(false);
    }
  }, [summary?.status, pollingPaused]);

  const [artifacts, setArtifacts] = useState({});
  const [events, setEvents] = useState([]);
  const [eventStreamError, setEventStreamError] = useState(null);

  useEffect(() => {
    if (!summary) return;
    let cancelled = false;
    async function fetchAll() {
      const names = (summary.artifacts || []).filter((name) => name.endsWith(".json"));
      const results = await Promise.allSettled(names.map((name) => getArtifact(id, name)));
      if (cancelled) return;
      const next = {};
      names.forEach((name, index) => {
        const r = results[index];
        if (r.status === "fulfilled") next[name] = r.value;
      });
      setArtifacts(next);
    }
    fetchAll();
    return () => {
      cancelled = true;
    };
    // Re-fetch on every poll. The summary reference changes on each tick,
    // so this drives a refresh whenever the dir mtime might have advanced.
    // mtime-only dependence is unreliable across filesystems (Linux ext4
    // doesn't bump dir mtime on file-content changes), and an artifact-count
    // dep silently freezes after the first full snapshot is written.
  }, [id, summary]);

  // Subscribe to SSE event tail. Only for developer view consumers, but
  // the operator view also wants the latest status, so we always tail.
  useEffect(() => {
    if (!id) return;
    setEvents([]);
    setEventStreamError(null);
    const close = subscribeEvents(
      id,
      (msg) => setEvents((prev) => [...prev, msg]),
      (err) => setEventStreamError(err)
    );
    return close;
  }, [id]);

  if (summaryError) {
    return (
      <div className="card p-4 text-sm text-danger-500">
        Failed to load run: {String(summaryError.message || summaryError)}{" "}
        <Link to="/" className="link">
          Back to runs
        </Link>
      </div>
    );
  }
  if (loading && !summary) {
    return <div className="card p-4 text-sm text-ink-400">Loading run…</div>;
  }
  if (!summary) {
    return <div className="card p-4 text-sm text-ink-400">No data.</div>;
  }

  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold tracking-tight">{id}</h1>
            <StatusPill status={summary.status} />
          </div>
          <p className="mt-1 text-xs text-ink-500">
            {summary.completed_at
              ? `Completed ${summary.completed_at}`
              : summary.modified_at
                ? `Updated ${summary.modified_at}`
                : "Run started"}
            {summary.selected_topology && (
              <span className="ml-2 font-mono text-ink-300">
                · selected: {summary.selected_topology}
              </span>
            )}
          </p>
        </div>
        <ModeToggle mode={mode} onChange={setMode} />
      </header>

      {eventStreamError && (
        <div className="rounded-md border border-warn-600/40 bg-warn-500/10 px-3 py-2 text-xs text-warn-500">
          Event stream disconnected. The page will keep polling artifacts.
        </div>
      )}

      {mode === "operator" ? (
        <OperatorView summary={summary} artifacts={artifacts} />
      ) : (
        <DeveloperView summary={summary} artifacts={artifacts} events={events} />
      )}
    </section>
  );
}

function ModeToggle({ mode, onChange }) {
  const base = "rounded-md px-3 py-1.5 text-sm";
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-ink-700">
      <button
        type="button"
        className={`${base} ${mode === "operator" ? "bg-accent-500 text-ink-950 font-medium" : "bg-ink-900 text-ink-300 hover:bg-ink-800"}`}
        onClick={() => onChange("operator")}
      >
        Operator
      </button>
      <button
        type="button"
        className={`${base} ${mode === "developer" ? "bg-accent-500 text-ink-950 font-medium" : "bg-ink-900 text-ink-300 hover:bg-ink-800"}`}
        onClick={() => onChange("developer")}
      >
        Developer
      </button>
    </div>
  );
}
