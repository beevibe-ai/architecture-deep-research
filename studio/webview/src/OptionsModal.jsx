import React from "react";

// Compare generated candidate architectures and load one. The human is the judge.
export default function OptionsModal({ state, onUse, onClose }) {
  if (!state) return null;
  const generating = state.status === "generating";
  const idea = (state.idea || "").trim();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{idea ? "Co-design suggestions" : "Generated options"}{generating ? "" : ` (${state.options.length})`}</span>
          <button className="mini-btn ghost" onClick={onClose}>✕</button>
        </div>
        {idea && <div className="modal-idea">{idea}</div>}

        {generating && (
          <div className="modal-loading">
            <div className="spinner" />
            <div>
              {idea ? "Exploring architecture changes…" : "Generating candidate architectures from your requirements…"}
              {state.progress && <div className="modal-progress">{state.progress.index + 1}/{state.count} · {state.progress.label}</div>}
            </div>
          </div>
        )}

        {!generating && (
          <div className="options-grid">
            {state.options.map((o) => (
              <div className="option-card" key={o.id}>
                <div className="option-title">{o.label}</div>
                <div className="option-components">
                  {o.components.length ? o.components.map((c, i) => <span className="option-chip" key={i}>{c}</span>) : <span className="option-empty">no components</span>}
                </div>
                <div className="option-rationale">{o.rationale}</div>
                <button className="btn" onClick={() => onUse(o)} disabled={!o.components.length}>{idea ? "Apply suggestion" : "Use this design"}</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
