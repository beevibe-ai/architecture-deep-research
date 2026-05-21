export default function PlanCard({ plan }) {
  const tasks = plan?.tasks || [];
  if (tasks.length === 0) return null;
  return (
    <div className="card p-5 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="card-title">Research plan</h2>
        <div className="text-xs text-ink-500">
          {plan.architecture} · {tasks.length} tasks
        </div>
      </div>
      <ol className="space-y-3">
        {tasks.map((task) => (
          <li key={task.id} className="rounded-lg border border-ink-800 bg-ink-900/40 p-3">
            <div className="flex items-baseline justify-between">
              <span className="font-semibold text-ink-200">
                <code className="font-mono text-xs text-accent-400">{task.id}</code>
                <span className="ml-2">{task.title}</span>
              </span>
            </div>
            {task.objective && <p className="mt-1 text-xs text-ink-400">{task.objective}</p>}
            {Array.isArray(task.search_queries) && task.search_queries.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {task.search_queries.map((q, i) => (
                  <code key={i} className="kbd">
                    {q}
                  </code>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
