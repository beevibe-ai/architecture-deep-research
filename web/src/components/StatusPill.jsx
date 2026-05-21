const STATUS_STYLES = {
  completed: "pill-success",
  in_progress: "pill-info",
  needs_clarification: "pill-warn",
  aborted_by_human: "pill-danger",
  unknown: "pill"
};

export default function StatusPill({ status }) {
  const className = STATUS_STYLES[status] || "pill";
  return <span className={className}>{status || "unknown"}</span>;
}
