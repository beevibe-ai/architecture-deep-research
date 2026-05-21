import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { startRun } from "../lib/api.js";

const RUNTIMES = [
  { id: "openai", label: "OpenAI-compatible (default)", needs_model: false },
  { id: "langgraph", label: "LangGraph (LangChain initChatModel)", needs_model: true },
  { id: "adk", label: "Google ADK (Gemini)", needs_model: false }
];

export default function NewRunForm() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    inputPath: "examples/logistics-contract-mesh/product-context.md",
    domain: "global logistics contract analysis",
    decision: "retrieval topology",
    outDir: ".adr-runs/logistics-contract-mesh",
    runtime: "openai",
    model: "openai:gpt-4.1-mini",
    maxCycles: "2",
    maxSources: "4",
    skipCritique: false,
    skipCitationAudit: false,
    skipComparisonMatrix: false
  });
  const [submitting, setSubmitting] = useState(false);
  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);

  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setResponse(null);
    setError(null);
    const flags = {};
    if (form.maxCycles) flags["max-cycles"] = form.maxCycles;
    if (form.maxSources) flags["max-sources"] = form.maxSources;
    if (form.skipCritique) flags["skip-critique"] = true;
    if (form.skipCitationAudit) flags["skip-citation-audit"] = true;
    if (form.skipComparisonMatrix) flags["skip-comparison-matrix"] = true;
    try {
      const result = await startRun({
        inputPath: form.inputPath,
        domain: form.domain,
        decision: form.decision,
        outDir: form.outDir,
        runtime: form.runtime,
        model: form.runtime === "langgraph" ? form.model : undefined,
        flags
      });
      setResponse(result);
      setTimeout(() => {
        const segments = form.outDir.split("/");
        navigate(`/runs/${encodeURIComponent(segments[segments.length - 1])}`);
      }, 800);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const selectedRuntime = RUNTIMES.find((r) => r.id === form.runtime);

  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Start a new run</h1>
        <p className="text-xs text-ink-500">
          The server spawns the same CLI under the hood. Required env (search provider + LLM key) must
          be present in the server's environment.
        </p>
      </header>

      <form onSubmit={onSubmit} className="card space-y-4 p-5">
        <Field label="Product context path" value={form.inputPath} onChange={(v) => update("inputPath", v)} />
        <Field label="Domain" value={form.domain} onChange={(v) => update("domain", v)} />
        <Field label="Decision focus" value={form.decision} onChange={(v) => update("decision", v)} />
        <Field label="Output directory" value={form.outDir} onChange={(v) => update("outDir", v)} />

        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-ink-400">Runtime</label>
          <select
            value={form.runtime}
            onChange={(e) => update("runtime", e.target.value)}
            className="mt-1 w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm"
          >
            {RUNTIMES.map((rt) => (
              <option key={rt.id} value={rt.id}>
                {rt.label}
              </option>
            ))}
          </select>
        </div>

        {selectedRuntime?.needs_model && (
          <Field
            label="Model (provider:model, passed to initChatModel)"
            value={form.model}
            onChange={(v) => update("model", v)}
            placeholder="openai:gpt-4.1-mini"
          />
        )}

        <div className="grid grid-cols-2 gap-4">
          <Field label="--max-cycles" value={form.maxCycles} onChange={(v) => update("maxCycles", v)} />
          <Field label="--max-sources" value={form.maxSources} onChange={(v) => update("maxSources", v)} />
        </div>

        <fieldset className="grid grid-cols-3 gap-3 rounded-lg border border-ink-800 p-3">
          <Checkbox
            label="--skip-critique"
            checked={form.skipCritique}
            onChange={(v) => update("skipCritique", v)}
          />
          <Checkbox
            label="--skip-citation-audit"
            checked={form.skipCitationAudit}
            onChange={(v) => update("skipCitationAudit", v)}
          />
          <Checkbox
            label="--skip-comparison-matrix"
            checked={form.skipComparisonMatrix}
            onChange={(v) => update("skipComparisonMatrix", v)}
          />
        </fieldset>

        <div className="flex items-center justify-between">
          <p className="text-xs text-ink-500">
            The run is spawned as a detached child process. Follow progress on the run page.
          </p>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-ink-950 disabled:opacity-60"
          >
            {submitting ? "Starting…" : "Start run"}
          </button>
        </div>

        {response && (
          <div className="rounded-md border border-success-600/30 bg-success-500/10 p-3 text-xs text-success-500">
            Started (pid {response.pid}). Redirecting to run page…
          </div>
        )}
        {error && (
          <div className="rounded-md border border-danger-600/30 bg-danger-500/10 p-3 text-xs text-danger-500">
            {String(error.message || error)}
          </div>
        )}
      </form>
    </section>
  );
}

function Field({ label, value, onChange, placeholder }) {
  return (
    <div>
      <label className="block text-xs font-medium uppercase tracking-wide text-ink-400">{label}</label>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm font-mono"
      />
    </div>
  );
}

function Checkbox({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-2 text-xs text-ink-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-ink-600 bg-ink-900"
      />
      <span className="font-mono">{label}</span>
    </label>
  );
}
