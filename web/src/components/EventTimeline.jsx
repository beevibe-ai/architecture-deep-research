const TYPE_TONE = {
  run_started: "bg-accent-500/20 text-accent-400",
  run_completed: "bg-success-500/20 text-success-500",
  run_waiting_for_clarification: "bg-warn-500/20 text-warn-500",
  research_agent_started: "bg-ink-700 text-ink-200",
  research_agent_finished: "bg-ink-700 text-ink-200",
  research_round_started: "bg-ink-800 text-ink-300",
  research_round_completed: "bg-ink-800 text-ink-300",
  research_round_judged: "bg-accent-500/10 text-accent-400",
  research_batch_started: "bg-ink-800 text-ink-300",
  strategic_context_created: "bg-ink-700 text-ink-200",
  research_plan_created: "bg-ink-700 text-ink-200",
  evidence_collected: "bg-success-500/10 text-success-500",
  critique_completed: "bg-warn-500/10 text-warn-500",
  citation_audit_completed: "bg-accent-500/10 text-accent-400",
  decision_downgraded_by_critique: "bg-danger-500/15 text-danger-500",
  adaptive_research_cycle_started: "bg-warn-500/10 text-warn-500",
  adaptive_research_cycle_completed: "bg-warn-500/10 text-warn-500",
  adaptive_research_cycle_skipped: "bg-ink-800 text-ink-400",
  live_tail_started: "bg-ink-800 text-ink-500",
  error: "bg-danger-500/20 text-danger-500"
};

export default function EventTimeline({ events, onSelect, selected }) {
  if (events.length === 0) {
    return (
      <div className="p-4 text-xs text-ink-500">
        No events yet. Run state writes append to <code className="kbd">events.jsonl</code>.
      </div>
    );
  }
  return (
    <ol className="divide-y divide-ink-800">
      {events.map((event, idx) => {
        const tone = TYPE_TONE[event.type] || "bg-ink-800 text-ink-300";
        const isSelected = selected === event;
        return (
          <li key={`${idx}|${event.ts || ""}|${event.type || ""}`}>
            <button
              type="button"
              onClick={() => onSelect?.(event)}
              aria-pressed={isSelected}
              className={`flex w-full items-baseline gap-3 px-3 py-2 text-left hover:bg-ink-900/40 focus:outline-none focus-visible:bg-ink-900/60 focus-visible:ring-1 focus-visible:ring-accent-500 ${isSelected ? "bg-ink-900/60" : ""}`}
            >
              <span className="w-24 shrink-0 font-mono text-[10px] text-ink-400">
                {formatTs(event.ts)}
              </span>
              <span
                className={`whitespace-nowrap rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
              >
                {event.type || "event"}
              </span>
              <span className="truncate text-xs text-ink-200">{summarizeEvent(event)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function formatTs(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toISOString().slice(11, 23);
  } catch {
    return ts;
  }
}

function summarizeEvent(event) {
  const fields = [
    "task_id",
    "title",
    "round",
    "evidence_count",
    "complete",
    "reason",
    "selected_topology",
    "issue_count",
    "promoted_candidate_count",
    "unsupported_count"
  ];
  const summaryFields = fields
    .filter((field) => event[field] !== undefined)
    .map((field) => `${field}=${truncate(event[field])}`);
  return summaryFields.join(" · ") || "—";
}

function truncate(value) {
  if (typeof value === "string" && value.length > 40) return value.slice(0, 37) + "…";
  if (Array.isArray(value)) return `[${value.length}]`;
  return String(value);
}
