import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getArtifact, getRun, subscribeEvents } from "../lib/api.js";
import { usePolling } from "../lib/usePolling.js";
import OperatorView from "./OperatorView.jsx";
import DeveloperView from "./DeveloperView.jsx";
import StatusPill from "../components/StatusPill.jsx";
import RelativeTime from "../components/RelativeTime.jsx";

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

  const lastFetchedAtRef = useRef(null);
  if (summary) lastFetchedAtRef.current = Date.now();

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
    return (
      <div className="card p-4 text-sm text-ink-300" role="status" aria-live="polite">
        Loading run <span className="font-mono">{id}</span>…
      </div>
    );
  }
  if (!summary) {
    return (
      <div className="card p-4 text-sm text-ink-300">
        No data for <span className="font-mono">{id}</span>.{" "}
        <Link to="/" className="link">
          Back to runs
        </Link>
      </div>
    );
  }

  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold tracking-tight">{id}</h1>
            <StatusPill status={summary.status} />
          </div>
          <p className="mt-1 text-xs text-ink-400">
            {summary.completed_at
              ? `Completed ${summary.completed_at}`
              : summary.modified_at
                ? `Updated ${summary.modified_at}`
                : "Run started"}
            {summary.selected_topology && (
              <span className="ml-2 font-mono text-ink-200">
                · selected: {summary.selected_topology}
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-ink-500" aria-live="polite">
            {pollingPaused ? (
              <>Polling paused — run reached terminal status.</>
            ) : lastFetchedAtRef.current ? (
              <>
                Auto-refreshing every 4s · last update{" "}
                <RelativeTime timestamp={lastFetchedAtRef.current} />
              </>
            ) : (
              <>Connecting…</>
            )}
          </p>
        </div>
        <ModeToggle mode={mode} onChange={setMode} />
      </header>

      {eventStreamError && (
        <div
          role="alert"
          className="rounded-md border border-warn-600/40 bg-warn-500/10 px-3 py-2 text-xs text-warn-500"
        >
          Event stream disconnected. Artifacts still refresh via polling — the stream will retry
          automatically; reload the page if it doesn't recover.
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
  const base =
    "rounded-md px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-500";
  return (
    <div
      role="tablist"
      aria-label="View mode"
      className="inline-flex overflow-hidden rounded-lg border border-ink-700"
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === "operator"}
        className={`${base} ${mode === "operator" ? "bg-accent-500 text-ink-950 font-medium" : "bg-ink-900 text-ink-200 hover:bg-ink-800"}`}
        onClick={() => onChange("operator")}
      >
        Operator
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "developer"}
        className={`${base} ${mode === "developer" ? "bg-accent-500 text-ink-950 font-medium" : "bg-ink-900 text-ink-200 hover:bg-ink-800"}`}
        onClick={() => onChange("developer")}
      >
        Developer
      </button>
    </div>
  );
}
