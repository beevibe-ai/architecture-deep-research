import React, { useState, useEffect } from "react";
import { applyMutation, SEQ_MESSAGE_TYPES } from "../../../shared/ir.mjs";

// Sequence diagrams are time-ordered, not free-canvas — so this is a purpose-built
// editable renderer: participant columns + lifelines + ordered message arrows.
const COL_W = 190, HEADER_H = 46, ROW_H = 52, TOP = 84, LEFT = 50;

export default function SequenceView({ spec, commit }) {
  const seqs = spec.views.sequences;
  const [activeId, setActiveId] = useState(seqs[0]?.id || null);
  const [sel, setSel] = useState(null); // { kind:"participant"|"message", id }
  const seq = seqs.find((s) => s.id === activeId) || seqs[0] || null;

  useEffect(() => { if (!seqs.find((s) => s.id === activeId)) setActiveId(seqs[0]?.id || null); }, [seqs, activeId]);

  const mut = (m) => commit(applyMutation(spec, m));
  const addSeq = () => { const s = applyMutation(spec, { op: "add_sequence", view: "sequences", name: `Sequence ${seqs.length + 1}` }); commit(s); setActiveId(s.views.sequences.at(-1).id); };

  const cx = (pid) => { const i = seq.participants.findIndex((p) => p.id === pid); return LEFT + i * COL_W + COL_W / 2; };
  const width = seq ? Math.max(600, LEFT * 2 + seq.participants.length * COL_W) : 600;
  const height = seq ? TOP + seq.messages.length * ROW_H + 70 : 300;

  const selParticipant = sel?.kind === "participant" ? seq?.participants.find((p) => p.id === sel.id) : null;
  const selMessage = sel?.kind === "message" ? seq?.messages.find((mm) => mm.id === sel.id) : null;

  return (
    <div className="view-area">
      <aside className="palette">
        <div className="palette-head">Sequence</div>
        <button className="mini-btn" onClick={() => seq && mut({ op: "add_participant", view: "sequences", seq: seq.id, label: "Participant" })} disabled={!seq}>+ participant</button>
        <button className="mini-btn" onClick={() => { if (seq && seq.participants.length >= 1) mut({ op: "add_message", view: "sequences", seq: seq.id, from: seq.participants[0].id, to: seq.participants[Math.min(1, seq.participants.length - 1)].id, label: "message", type: "sync" }); }} disabled={!seq || seq.participants.length < 1}>+ message</button>
        <div className="palette-hint">Add participants, then messages between them. Edit order/type in the inspector.</div>
      </aside>

      <div className="canvas-wrap seq-wrap">
        <div className="flow-bar">
          <select value={seq ? seq.id : ""} onChange={(e) => { setActiveId(e.target.value); setSel(null); }} disabled={!seqs.length}>
            {seqs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {!seqs.length && <option value="">no sequences</option>}
          </select>
          <button className="mini-btn" onClick={addSeq}>+ sequence</button>
          {seq && <button className="mini-btn ghost" onClick={() => mut({ op: "remove_sequence", view: "sequences", id: seq.id })}>delete</button>}
        </div>

        <div className="seq-scroll">
          {!seqs.length && <div className="empty-hint">Add a sequence, then participants and messages.</div>}
          {seq && (
            <svg width={width} height={height} className="seq-svg">
              <defs>
                <marker id="arrow-solid" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#b9c5ff" /></marker>
                <marker id="arrow-open" markerWidth="12" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6" fill="none" stroke="#9ee3c6" strokeWidth="1.2" /></marker>
              </defs>
              {/* participants + lifelines */}
              {seq.participants.map((p) => (
                <g key={p.id} onClick={() => setSel({ kind: "participant", id: p.id })} style={{ cursor: "pointer" }}>
                  <line x1={cx(p.id)} y1={HEADER_H + 12} x2={cx(p.id)} y2={height - 30} stroke="#3a3f52" strokeDasharray="4 4" />
                  <rect x={cx(p.id) - 70} y={12} width={140} height={HEADER_H} rx={8} fill={selParticipant?.id === p.id ? "#2a3350" : "#232a36"} stroke={selParticipant?.id === p.id ? "#b9c5ff" : "#3a3f52"} />
                  <text x={cx(p.id)} y={12 + HEADER_H / 2 + 4} textAnchor="middle" fill="#e7e9f2" fontSize="12" fontWeight="600">{p.label}</text>
                </g>
              ))}
              {/* messages */}
              {seq.messages.map((mm, k) => {
                const y = TOP + k * ROW_H;
                const x1 = cx(mm.from), x2 = cx(mm.to);
                const dashed = mm.type === "return";
                const marker = mm.type === "async" || mm.type === "return" ? "url(#arrow-open)" : "url(#arrow-solid)";
                const selStroke = selMessage?.id === mm.id ? "#b9c5ff" : "#cfd4e8";
                if (mm.from === mm.to) {
                  // self-message loop
                  return (
                    <g key={mm.id} onClick={() => setSel({ kind: "message", id: mm.id })} style={{ cursor: "pointer" }}>
                      <path d={`M${x1},${y} h40 v22 h-40`} fill="none" stroke={selStroke} strokeDasharray={dashed ? "5 4" : ""} markerEnd={marker} />
                      <text x={x1 + 46} y={y - 4} fill="#cfd4e8" fontSize="11">{mm.label}</text>
                    </g>
                  );
                }
                return (
                  <g key={mm.id} onClick={() => setSel({ kind: "message", id: mm.id })} style={{ cursor: "pointer" }}>
                    <line x1={x1} y1={y} x2={x2} y2={y} stroke="transparent" strokeWidth="16" />
                    <line x1={x1} y1={y} x2={x2} y2={y} stroke={selStroke} strokeDasharray={dashed ? "5 4" : ""} markerEnd={marker} />
                    <text x={(x1 + x2) / 2} y={y - 6} textAnchor="middle" fill="#cfd4e8" fontSize="11">{mm.label}</text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {selParticipant && (
          <div className="inspector" onClick={(e) => e.stopPropagation()}>
            <div className="insp-head">participant</div>
            <label>Label</label>
            <input value={selParticipant.label} onChange={(e) => mut({ op: "update_participant", view: "sequences", seq: seq.id, id: selParticipant.id, label: e.target.value })} />
            <div className="field-row">
              <button className="mini-btn" onClick={() => mut({ op: "move_participant", view: "sequences", seq: seq.id, id: selParticipant.id, dir: "left" })}>← left</button>
              <button className="mini-btn" onClick={() => mut({ op: "move_participant", view: "sequences", seq: seq.id, id: selParticipant.id, dir: "right" })}>right →</button>
              <button className="mini-btn ghost" onClick={() => { mut({ op: "remove_participant", view: "sequences", seq: seq.id, id: selParticipant.id }); setSel(null); }}>delete</button>
            </div>
          </div>
        )}

        {selMessage && (
          <div className="inspector" onClick={(e) => e.stopPropagation()}>
            <div className="insp-head">message</div>
            <label>From</label>
            <select value={selMessage.from} onChange={(e) => mut({ op: "update_message", view: "sequences", seq: seq.id, id: selMessage.id, from: e.target.value })}>
              {seq.participants.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <label>To</label>
            <select value={selMessage.to} onChange={(e) => mut({ op: "update_message", view: "sequences", seq: seq.id, id: selMessage.id, to: e.target.value })}>
              {seq.participants.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <label>Label</label>
            <input value={selMessage.label} onChange={(e) => mut({ op: "update_message", view: "sequences", seq: seq.id, id: selMessage.id, label: e.target.value })} />
            <label>Type</label>
            <select value={selMessage.type} onChange={(e) => mut({ op: "update_message", view: "sequences", seq: seq.id, id: selMessage.id, type: e.target.value })}>
              {SEQ_MESSAGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <div className="field-row">
              <button className="mini-btn" onClick={() => mut({ op: "move_message", view: "sequences", seq: seq.id, id: selMessage.id, dir: "up" })}>↑ up</button>
              <button className="mini-btn" onClick={() => mut({ op: "move_message", view: "sequences", seq: seq.id, id: selMessage.id, dir: "down" })}>↓ down</button>
              <button className="mini-btn ghost" onClick={() => { mut({ op: "remove_message", view: "sequences", seq: seq.id, id: selMessage.id }); setSel(null); }}>delete</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
