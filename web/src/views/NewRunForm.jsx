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

  function deriveRunId(outDir) {
    return String(outDir || "")
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean)
      .pop();
  }

  async function onSubmit(event) {
    event.preventDefault();
    setResponse(null);
    setError(null);

    const required = ["inputPath", "domain", "decision", "outDir"];
    const missing = required.filter((key) => !String(form[key] || "").trim());
    if (missing.length > 0) {
      setError(new Error(`Required: ${missing.join(", ")}`));
      return;
    }
    if (form.runtime === "langgraph" && !String(form.model || "").trim()) {
      setError(new Error("Model is required for the LangGraph runtime."));
      return;
    }
    const runId = deriveRunId(form.outDir);
    if (!runId) {
      setError(new Error("Output directory must end with a run name (e.g. .adr-runs/my-run)."));
      return;
    }
    const numericFields = { maxCycles: "max-cycles", maxSources: "max-sources" };
    for (const [field, flag] of Object.entries(numericFields)) {
      if (form[field] && !/^\d+$/.test(String(form[field]).trim())) {
        setError(new Error(`--${flag} must be a positive integer.`));
        return;
      }
    }

    setSubmitting(true);
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
      setResponse({ ...result, runId });
      // Give the kernel ~800ms to create the run dir before navigating; if
      // the user prefers, the success banner exposes a manual link too.
      setTimeout(() => navigate(`/runs/${encodeURIComponent(runId)}`), 800);
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
        <h1 className="text-xl font-semibold tracking-tight">Start a new run</h1>
        <p className="text-xs text-ink-500">
          The server spawns the same CLI under the hood. Required env (search provider + LLM key) must
          be present in the server's environment.
        </p>
      </header>

      <form onSubmit={onSubmit} noValidate className="card space-y-4 p-5">
        <Field
          id="field-input-path"
          label="Product context path"
          value={form.inputPath}
          onChange={(v) => update("inputPath", v)}
          required
          autoFocus
        />
        <Field
          id="field-domain"
          label="Domain"
          value={form.domain}
          onChange={(v) => update("domain", v)}
          required
        />
        <Field
          id="field-decision"
          label="Decision focus"
          value={form.decision}
          onChange={(v) => update("decision", v)}
          required
        />
        <Field
          id="field-out-dir"
          label="Output directory"
          value={form.outDir}
          onChange={(v) => update("outDir", v)}
          required
        />

        <div>
          <label
            htmlFor="field-runtime"
            className="block text-xs font-medium uppercase tracking-wide text-ink-300"
          >
            Runtime
          </label>
          <select
            id="field-runtime"
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
            id="field-model"
            label="Model (provider:model, passed to initChatModel)"
            value={form.model}
            onChange={(v) => update("model", v)}
            placeholder="openai:gpt-4.1-mini"
          />
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            id="field-max-cycles"
            label="--max-cycles"
            value={form.maxCycles}
            onChange={(v) => update("maxCycles", v)}
            inputMode="numeric"
          />
          <Field
            id="field-max-sources"
            label="--max-sources"
            value={form.maxSources}
            onChange={(v) => update("maxSources", v)}
            inputMode="numeric"
          />
        </div>

        <fieldset className="grid grid-cols-1 gap-3 rounded-lg border border-ink-800 p-3 sm:grid-cols-3">
          <legend className="px-1 text-xs uppercase tracking-wide text-ink-300">Skip phases</legend>
          <Checkbox
            id="field-skip-critique"
            label="--skip-critique"
            checked={form.skipCritique}
            onChange={(v) => update("skipCritique", v)}
          />
          <Checkbox
            id="field-skip-citation-audit"
            label="--skip-citation-audit"
            checked={form.skipCitationAudit}
            onChange={(v) => update("skipCitationAudit", v)}
          />
          <Checkbox
            id="field-skip-comparison-matrix"
            label="--skip-comparison-matrix"
            checked={form.skipComparisonMatrix}
            onChange={(v) => update("skipComparisonMatrix", v)}
          />
        </fieldset>

        <div className="flex items-center justify-between">
          <p className="text-xs text-ink-500">
            The run is spawned as a detached child process. Follow progress on the run page.
          </p>
          <button type="submit" disabled={submitting} aria-busy={submitting} className="btn-primary">
            {submitting ? "Starting…" : "Start run"}
          </button>
        </div>

        {response && (
          <div className="banner-success" role="status" aria-live="polite">
            Started{response.pid ? ` (pid ${response.pid})` : ""}. Redirecting…{" "}
            <a className="link" href={`/runs/${encodeURIComponent(response.runId)}`}>
              Go to run page
            </a>
            {" "}if it doesn't load.
          </div>
        )}
        {error && (
          <div role="alert" className="banner-danger">
            {String(error.message || error)}
          </div>
        )}
      </form>
    </section>
  );
}

function Field({ id, label, value, onChange, placeholder, required, autoFocus, inputMode }) {
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-xs font-medium uppercase tracking-wide text-ink-300"
      >
        {label}
        {required && (
          <span aria-hidden="true" className="ml-1 text-danger-500">
            *
          </span>
        )}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        required={required}
        aria-required={required ? "true" : undefined}
        autoFocus={autoFocus}
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm font-mono focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
      />
    </div>
  );
}

function Checkbox({ id, label, checked, onChange }) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-xs text-ink-200">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-ink-600 bg-ink-900"
      />
      <span className="font-mono">{label}</span>
    </label>
  );
}
