import React, { useCallback, useEffect, useRef, useState } from "react";
import { applyMutation, SEQ_MESSAGE_TYPES } from "../../../shared/ir.mjs";

// Sequence diagrams are time-ordered, not free-canvas, so this renderer keeps
// the structure fixed while making the labels and local actions editable in
// place.
const COL_W = 190, HEADER_H = 46, ROW_H = 52, TOP = 104, LEFT = 50;
const MIN_ZOOM = 0.35, MAX_ZOOM = 1.6, ZOOM_STEP = 0.15;

function clampZoom(value) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

function stop(e) {
  e.stopPropagation();
}

export default function SequenceView({ spec, commit }) {
  const seqs = spec.views.sequences;
  const [activeId, setActiveId] = useState(seqs[0]?.id || null);
  const [sel, setSel] = useState(null); // { kind:"participant"|"message", id }
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef(null);
  const seq = seqs.find((s) => s.id === activeId) || seqs[0] || null;

  useEffect(() => { if (!seqs.find((s) => s.id === activeId)) setActiveId(seqs[0]?.id || null); }, [seqs, activeId]);
  useEffect(() => {
    if (!seq) return;
    if (sel?.kind === "participant" && !seq.participants.some((p) => p.id === sel.id)) setSel(null);
    if (sel?.kind === "message" && !seq.messages.some((m) => m.id === sel.id)) setSel(null);
  }, [seq, sel]);

  const mut = useCallback((m) => commit(applyMutation(spec, m)), [spec, commit]);
  const addSeq = () => {
    const s = applyMutation(spec, { op: "add_sequence", view: "sequences", name: `Sequence ${seqs.length + 1}` });
    commit(s);
    setActiveId(s.views.sequences.at(-1).id);
    setSel(null);
  };

  const cx = (pid) => {
    const i = seq.participants.findIndex((p) => p.id === pid);
    return LEFT + Math.max(0, i) * COL_W + COL_W / 2;
  };
  const width = seq ? Math.max(760, LEFT * 2 + seq.participants.length * COL_W) : 760;
  const height = seq ? TOP + Math.max(1, seq.messages.length) * ROW_H + 90 : 360;
  const scaledWidth = Math.ceil(width * zoom);
  const scaledHeight = Math.ceil(height * zoom);

  const fitToScreen = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !seq) return;
    const zx = (el.clientWidth - 42) / width;
    const zy = (el.clientHeight - 42) / height;
    setZoom(clampZoom(Math.min(1, zx, zy)));
    el.scrollTo({ left: 0, top: 0, behavior: "smooth" });
  }, [height, seq, width]);

  const addParticipant = () => {
    if (!seq) return;
    const next = applyMutation(spec, { op: "add_participant", view: "sequences", seq: seq.id, label: `Participant ${seq.participants.length + 1}` });
    commit(next);
    setSel({ kind: "participant", id: next.views.sequences.find((s) => s.id === seq.id).participants.at(-1).id });
  };
  const addMessage = () => {
    if (!seq || seq.participants.length < 1) return;
    const from = sel?.kind === "participant" ? sel.id : seq.participants[0].id;
    const fromIndex = seq.participants.findIndex((p) => p.id === from);
    const toIndex = seq.participants.length === 1
      ? fromIndex
      : fromIndex < seq.participants.length - 1 ? fromIndex + 1 : fromIndex - 1;
    const to = seq.participants[toIndex]?.id || from;
    const next = applyMutation(spec, { op: "add_message", view: "sequences", seq: seq.id, from, to, label: "message", type: "sync" });
    commit(next);
    setSel({ kind: "message", id: next.views.sequences.find((s) => s.id === seq.id).messages.at(-1).id });
  };

  const selParticipant = sel?.kind === "participant" ? seq?.participants.find((p) => p.id === sel.id) : null;
  const selMessage = sel?.kind === "message" ? seq?.messages.find((mm) => mm.id === sel.id) : null;

  return (
    <div className="view-area">
      <aside className="palette seq-palette">
        <div className="palette-head">Sequence</div>
        <button className="mini-btn" onClick={addParticipant} disabled={!seq}>+ participant</button>
        <button className="mini-btn" onClick={addMessage} disabled={!seq || seq.participants.length < 1}>+ message</button>
        <div className="palette-hint">Click a label and type directly on the diagram.</div>
      </aside>

      <div className="canvas-wrap seq-wrap">
        <div className="flow-bar seq-bar">
          <select value={seq ? seq.id : ""} onChange={(e) => { setActiveId(e.target.value); setSel(null); }} disabled={!seqs.length} aria-label="Sequence">
            {seqs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {!seqs.length && <option value="">no sequences</option>}
          </select>
          {seq && (
            <input
              className="seq-title-input"
              value={seq.name}
              onChange={(e) => mut({ op: "rename_sequence", view: "sequences", id: seq.id, name: e.target.value })}
              aria-label="Sequence name"
            />
          )}
          <button className="mini-btn" onClick={() => commit(applyMutation(spec, { op: "derive", view: "sequences" }))}>Sync from architecture</button>
          <button className="mini-btn" onClick={addSeq}>+ sequence</button>
          {seq && <button className="mini-btn ghost" onClick={() => mut({ op: "remove_sequence", view: "sequences", id: seq.id })}>delete</button>}
          <div className="seq-zoom" aria-label="Sequence zoom controls">
            <button className="mini-btn" onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))} title="Zoom out">-</button>
            <button className="mini-btn" onClick={fitToScreen} disabled={!seq} title="Fit sequence">Fit</button>
            <button className="mini-btn" onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))} title="Zoom in">+</button>
            <span>{Math.round(zoom * 100)}%</span>
          </div>
        </div>

        <div className="seq-scroll" ref={scrollRef} onClick={() => setSel(null)}>
          {!seqs.length && <div className="empty-hint">Add a sequence, then participants and messages.</div>}
          {seq && (
            <div className="seq-canvas" style={{ width: scaledWidth, height: scaledHeight }}>
              <svg width={width} height={height} className="seq-svg" style={{ transform: `scale(${zoom})` }}>
                <defs>
                  <marker id="arrow-solid" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#b9c5ff" /></marker>
                  <marker id="arrow-open" markerWidth="12" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6" fill="none" stroke="#9ee3c6" strokeWidth="1.2" /></marker>
                </defs>
                {seq.participants.map((p) => {
                  const selected = selParticipant?.id === p.id;
                  const x = cx(p.id);
                  return (
                    <g key={p.id} onClick={(e) => { stop(e); setSel({ kind: "participant", id: p.id }); }} style={{ cursor: "pointer" }}>
                      <line x1={x} y1={HEADER_H + 24} x2={x} y2={height - 30} stroke="#3a3f52" strokeDasharray="4 4" />
                      <rect x={x - 82} y={12} width={164} height={HEADER_H + 10} rx={8} fill={selected ? "#2a3350" : "#232a36"} stroke={selected ? "#b9c5ff" : "#3a3f52"} />
                      {selected ? (
                        <foreignObject x={x - 70} y={22} width={140} height={34} onClick={stop}>
                          <input
                            className="seq-inline-input participant"
                            value={p.label}
                            autoFocus
                            onChange={(e) => mut({ op: "update_participant", view: "sequences", seq: seq.id, id: p.id, label: e.target.value })}
                          />
                        </foreignObject>
                      ) : (
                        <text x={x} y={12 + HEADER_H / 2 + 9} textAnchor="middle" fill="#e7e9f2" fontSize="13" fontWeight="650">{p.label}</text>
                      )}
                      {selected && (
                        <foreignObject x={x - 86} y={68} width={172} height={30} onClick={stop}>
                          <div className="seq-inline-actions">
                            <button onClick={() => mut({ op: "move_participant", view: "sequences", seq: seq.id, id: p.id, dir: "left" })}>Left</button>
                            <button onClick={() => mut({ op: "move_participant", view: "sequences", seq: seq.id, id: p.id, dir: "right" })}>Right</button>
                            <button className="danger" onClick={() => { mut({ op: "remove_participant", view: "sequences", seq: seq.id, id: p.id }); setSel(null); }}>Delete</button>
                          </div>
                        </foreignObject>
                      )}
                    </g>
                  );
                })}
                {seq.messages.map((mm, k) => {
                  const y = TOP + k * ROW_H;
                  const x1 = cx(mm.from), x2 = cx(mm.to);
                  const dashed = mm.type === "return";
                  const marker = mm.type === "async" || mm.type === "return" ? "url(#arrow-open)" : "url(#arrow-solid)";
                  const selected = selMessage?.id === mm.id;
                  const stroke = selected ? "#b9c5ff" : "#cfd4e8";
                  const inputW = Math.min(300, Math.max(132, Math.abs(x2 - x1) - 28));
                  const inputX = mm.from === mm.to ? x1 + 44 : (x1 + x2) / 2 - inputW / 2;
                  const labelText = mm.label || "message";
                  const labelY = y - 22;
                  if (mm.from === mm.to) {
                    return (
                      <g key={mm.id} onClick={(e) => { stop(e); setSel({ kind: "message", id: mm.id }); }} style={{ cursor: "pointer" }}>
                        <path d={`M${x1},${y} h44 v24 h-44`} fill="none" stroke={stroke} strokeWidth={selected ? 1.7 : 1.2} strokeDasharray={dashed ? "5 4" : ""} markerEnd={marker} />
                        {selected ? <MessageEditor seq={seq} msg={mm} x={inputX} y={labelY} width={inputW} mut={mut} setSel={setSel} /> : <text x={x1 + 50} y={y - 6} fill="#cfd4e8" fontSize="11">{labelText}</text>}
                      </g>
                    );
                  }
                  return (
                    <g key={mm.id} onClick={(e) => { stop(e); setSel({ kind: "message", id: mm.id }); }} style={{ cursor: "pointer" }}>
                      <line x1={x1} y1={y} x2={x2} y2={y} stroke="transparent" strokeWidth="18" />
                      <line x1={x1} y1={y} x2={x2} y2={y} stroke={stroke} strokeWidth={selected ? 1.7 : 1.2} strokeDasharray={dashed ? "5 4" : ""} markerEnd={marker} />
                      {selected ? <MessageEditor seq={seq} msg={mm} x={inputX} y={labelY} width={inputW} mut={mut} setSel={setSel} /> : <text x={(x1 + x2) / 2} y={y - 6} textAnchor="middle" fill="#cfd4e8" fontSize="11">{labelText}</text>}
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageEditor({ seq, msg, x, y, width, mut, setSel }) {
  return (
    <>
      <foreignObject x={x} y={y - 12} width={width} height={34} onClick={stop}>
        <input
          className="seq-inline-input message"
          value={msg.label || ""}
          autoFocus
          onChange={(e) => mut({ op: "update_message", view: "sequences", seq: seq.id, id: msg.id, label: e.target.value })}
        />
      </foreignObject>
      <foreignObject x={x} y={y + 24} width={Math.max(width, 254)} height={34} onClick={stop}>
        <div className="seq-inline-actions message-actions">
          <select value={msg.type || "sync"} onChange={(e) => mut({ op: "update_message", view: "sequences", seq: seq.id, id: msg.id, type: e.target.value })}>
            {SEQ_MESSAGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button onClick={() => mut({ op: "move_message", view: "sequences", seq: seq.id, id: msg.id, dir: "up" })}>Up</button>
          <button onClick={() => mut({ op: "move_message", view: "sequences", seq: seq.id, id: msg.id, dir: "down" })}>Down</button>
          <button className="danger" onClick={() => { mut({ op: "remove_message", view: "sequences", seq: seq.id, id: msg.id }); setSel(null); }}>Delete</button>
        </div>
      </foreignObject>
    </>
  );
}
