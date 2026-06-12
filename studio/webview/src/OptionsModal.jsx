import React, { useEffect, useMemo, useState } from "react";

// Compare generated candidate architectures and load one. The human is the judge.
export default function OptionsModal({ state, onUse, onClose }) {
  const generating = state?.status === "generating";
  const idea = (state?.idea || "").trim();
  const options = state?.options || [];
  const [selectedId, setSelectedId] = useState("");
  useEffect(() => {
    if (!options.length) {
      setSelectedId("");
      return;
    }
    setSelectedId((current) => options.some((o) => o.id === current) ? current : options[0].id);
  }, [options]);
  const selected = useMemo(() => options.find((o) => o.id === selectedId) || options[0] || null, [options, selectedId]);
  if (!state) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{idea ? "Co-design suggestion" : "Generated options"}{generating ? "" : ` (${options.length})`}</span>
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
          options.length ? (
            <div className="options-layout">
              <div className="option-list" role="tablist" aria-label="Generated options">
                {options.map((o) => (
                  <button className={`option-row ${o.id === selected?.id ? "on" : ""}`} role="tab" aria-selected={o.id === selected?.id} key={o.id} onClick={() => setSelectedId(o.id)}>
                    <span className="option-row-title">{o.label}</span>
                    <span className="option-row-meta">{o.components.length || 0} components</span>
                    <span className="option-row-summary">{firstSentence(o.rationale)}</span>
                  </button>
                ))}
              </div>
              {selected && (
                <div className="option-detail">
                  <div className="option-detail-head">
                    <div>
                      <div className="option-title">{selected.label}</div>
                      <div className="option-subtitle">{selected.components.length || 0} top-level components</div>
                    </div>
                    <button className="btn" onClick={() => onUse(selected)} disabled={!selected.components.length}>{idea ? "Apply suggestion" : "Use this design"}</button>
                  </div>
                  <div className="option-components">
                    {selected.components.length ? selected.components.slice(0, 12).map((c, i) => <span className="option-chip" key={i}>{c}</span>) : <span className="option-empty">no components</span>}
                    {selected.components.length > 12 && <span className="option-empty">+{selected.components.length - 12} more</span>}
                  </div>
                  <div className="option-rationale">{selected.rationale}</div>
                </div>
              )}
            </div>
          ) : (
            <div className="option-empty">No options were generated.</div>
          )
        )}
      </div>
    </div>
  );
}

function firstSentence(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "No rationale returned.";
  const sentence = clean.match(/^(.{20,220}?[.!?])\s/)?.[1] || clean.slice(0, 180);
  return sentence.length < clean.length ? `${sentence.replace(/[.!?]$/, "")}...` : sentence;
}
