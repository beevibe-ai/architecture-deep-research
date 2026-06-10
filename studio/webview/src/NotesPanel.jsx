import React, { useState } from "react";
import { applyMutation, NOTE_KINDS, NOTE_PRIORITIES } from "../../shared/ir.mjs";

const KIND_LABEL = Object.fromEntries(NOTE_KINDS.map((k) => [k.id, k.label]));
const isReq = (kind) => kind === "functional" || kind === "non_functional";

// A lightweight notebook for functional/non-functional requirements, ideas,
// questions, decisions, and risks. Notes flow into plan.md and the handoff, and
// can be linked to a component for traceability.
export default function NotesPanel({ spec, commit }) {
  const [filter, setFilter] = useState("all");
  const notes = spec.notes || [];
  const components = spec.views.architecture.nodes;
  const shown = filter === "all" ? notes : notes.filter((n) => n.kind === filter);

  const add = () => commit(applyMutation(spec, { op: "add_note", kind: filter === "all" ? "functional" : filter, title: "", body: "" }));
  const update = (id, patch) => commit(applyMutation(spec, { op: "update_note", id, ...patch }));
  const remove = (id) => commit(applyMutation(spec, { op: "remove_note", id }));

  return (
    <div className="notes-panel">
      <div className="notes-filters">
        <button className={`notes-chip ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>All</button>
        {NOTE_KINDS.map((k) => (
          <button key={k.id} className={`notes-chip ${filter === k.id ? "on" : ""}`} onClick={() => setFilter(k.id)}>{k.label}</button>
        ))}
      </div>
      <div className="notes-actions">
        <button className="btn" onClick={add}>+ Note</button>
      </div>
      <div className="notes-scroll">
        {shown.length === 0 && <div className="notes-empty">No notes yet. Capture a requirement, idea, or decision — or ask the assistant to.</div>}
        {shown.map((n) => (
          <div className={`note note-${n.kind}`} key={n.id}>
            <div className="note-head">
              <select value={n.kind} onChange={(e) => update(n.id, { kind: e.target.value })}>
                {NOTE_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
              {isReq(n.kind) && (
                <select value={n.priority || ""} onChange={(e) => update(n.id, { priority: e.target.value || null })}>
                  <option value="">priority</option>
                  {NOTE_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              )}
              <button className="mini-btn ghost" onClick={() => remove(n.id)}>×</button>
            </div>
            <input className="note-title" placeholder="Title" value={n.title} onChange={(e) => update(n.id, { title: e.target.value })} />
            <textarea className="note-body" rows={2} placeholder="Detail…" value={n.body} onChange={(e) => update(n.id, { body: e.target.value })} />
            <select
              className="note-ref"
              value={n.refs?.[0]?.ref || ""}
              onChange={(e) => update(n.id, { refs: e.target.value ? [{ view: "architecture", ref: e.target.value }] : [] })}
            >
              <option value="">relates to… (optional)</option>
              {components.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
