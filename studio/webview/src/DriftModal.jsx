import React from "react";

// Drift between the design on the canvas and the architecture inferred from the
// real repo. The human reconciles: pull a real component into the design, fix a
// tech mismatch, or drop a box the code never built. Every "in code" claim shows
// the file it came from — cite-or-die, on the canvas.
export default function DriftModal({ state, onAdd, onFixTech, onRemove, onClose }) {
  if (!state) return null;
  const scanning = state.status === "scanning";
  const r = state.report;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal drift-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Drift vs the real repo{state.repo ? ` · ${state.repo}` : ""}</span>
          <button className="mini-btn ghost" onClick={onClose}>✕</button>
        </div>

        {scanning && (
          <div className="modal-loading">
            <div className="spinner" />
            <div>
              Reading the repo and reconstructing its real architecture…
              {state.stream ? <div className="drift-stream">{state.stream.slice(-200)}</div> : null}
            </div>
          </div>
        )}

        {!scanning && r && (
          <div className="drift-body">
            <div className="drift-summary">
              {r.summary.in_sync ? (
                <span className="drift-insync">✓ Your design matches the code — {r.summary.matched} components, no drift.</span>
              ) : (
                <span>
                  {r.summary.matched} in sync ·{" "}
                  <b className="drift-red">{r.summary.in_code_not_designed} in code, not drawn</b> ·{" "}
                  <b className="drift-amber">{r.summary.designed_not_in_code} drawn, not built</b> ·{" "}
                  <b className="drift-blue">{r.summary.tech_mismatch} tech mismatch</b>
                </span>
              )}
            </div>

            {r.in_code_not_designed.length > 0 && (
              <section className="drift-section">
                <h4 className="drift-red">In the code, not in your design</h4>
                {r.in_code_not_designed.map((d, i) => (
                  <div className="drift-row" key={i}>
                    <div className="drift-row-main">
                      <span className="drift-label">{d.label}</span>
                      {d.tech ? <span className="drift-tech">{d.tech}</span> : null}
                      {d.evidence?.length ? <span className="drift-cite">{d.evidence.join(", ")}</span> : null}
                    </div>
                    <button className="mini-btn" onClick={() => onAdd(d)}>Add to design</button>
                  </div>
                ))}
              </section>
            )}

            {r.tech_mismatch.length > 0 && (
              <section className="drift-section">
                <h4 className="drift-blue">Tech mismatch</h4>
                {r.tech_mismatch.map((d, i) => (
                  <div className="drift-row" key={i}>
                    <div className="drift-row-main">
                      <span className="drift-label">{d.label}</span>
                      <span className="drift-tech strike">{d.designed_tech || "—"}</span>
                      <span className="drift-arrow">→</span>
                      <span className="drift-tech">{d.actual_tech}</span>
                      {d.evidence?.length ? <span className="drift-cite">{d.evidence.join(", ")}</span> : null}
                    </div>
                    <button className="mini-btn" onClick={() => onFixTech(d)}>Use {d.actual_tech}</button>
                  </div>
                ))}
              </section>
            )}

            {r.designed_not_in_code.length > 0 && (
              <section className="drift-section">
                <h4 className="drift-amber">Drawn, but not in the code</h4>
                {r.designed_not_in_code.map((d, i) => (
                  <div className="drift-row" key={i}>
                    <div className="drift-row-main">
                      <span className="drift-label">{d.label}</span>
                      {d.tech ? <span className="drift-tech">{d.tech}</span> : null}
                      <span className="drift-note">no trace in repo</span>
                    </div>
                    <button className="mini-btn ghost" onClick={() => onRemove(d)}>Remove</button>
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
