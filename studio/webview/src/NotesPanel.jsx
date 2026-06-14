import React, { useMemo, useState } from "react";
import { applyMutation, NOTE_KINDS, NOTE_PRIORITIES } from "../../shared/ir.mjs";

const KIND_LABEL = Object.fromEntries(NOTE_KINDS.map((k) => [k.id, k.label]));
const isReq = (kind) => kind === "functional" || kind === "non_functional";
const MAX_TITLE = 90;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripPrefix(text) {
  return text
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")
    .replace(/^\s*(?:req|requirement|nfr|idea|question|decision|risk)\s*:\s*/i, "")
    .trim();
}

function titleFrom(text) {
  const first = stripPrefix(text.split(/\r?\n/).find((line) => line.trim()) || "");
  if (first.length <= MAX_TITLE) return first;
  return `${first.slice(0, MAX_TITLE - 1).trim()}…`;
}

function parseNoteText(text) {
  const raw = text.trim();
  if (!raw) return { title: "", body: "" };
  const lines = raw.split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => line.trim());
  if (firstIndex < 0) return { title: "", body: "" };
  const title = titleFrom(lines[firstIndex]);
  const body = lines.slice(firstIndex + 1).join("\n").trim();
  return { title, body };
}

function draftItems(text) {
  const raw = text.trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const bullets = lines
    .map((line) => line.trim())
    .filter((line) => /^\s*(?:[-*]|\d+[.)])\s+/.test(line))
    .map(stripPrefix)
    .filter(Boolean);
  return bullets.length > 1 ? bullets : [raw];
}

function inferKind(text, fallback = "idea") {
  const lower = text.toLowerCase();
  if (/[?？]\s*$/.test(text) || /^(how|what|why|when|who|can|should|do we|does)\b/.test(lower)) return "question";
  if (/\b(risk|risky|concern|blocker|blocked|failure|fail|missing|unsafe|security hole)\b/.test(lower)) return "risk";
  if (/\b(p99|latency|throughput|scale|scaling|availability|reliability|secure|security|privacy|cost|slo|sla|observability)\b/.test(lower)) return "non_functional";
  if (/\b(decide|decided|decision|we will|use|choose|selected|standardize)\b/.test(lower)) return "decision";
  if (/\b(must|need|needs|require|requires|required|should support|user can|users can|allow|enable)\b/.test(lower)) return "functional";
  if (/\b(idea|maybe|could|consider|explore|nice to have)\b/.test(lower)) return "idea";
  return fallback === "all" ? "idea" : fallback;
}

function inferPriority(text, kind) {
  if (!isReq(kind)) return null;
  const lower = text.toLowerCase();
  if (/\b(must|required|critical|blocker|p0|p1|cannot ship)\b/.test(lower)) return "must";
  if (/\b(should|important|p2)\b/.test(lower)) return "should";
  if (/\b(could|nice to have|later|p3)\b/.test(lower)) return "could";
  if (/\b(won't|wont|not now|out of scope)\b/.test(lower)) return "wont";
  return null;
}

function componentMentions(text, components) {
  const lower = text.toLowerCase();
  return components.filter((component) => {
    const label = (component.label || "").toLowerCase();
    const id = (component.id || "").toLowerCase();
    if (!label) return false;
    const slug = label.replace(/\s+/g, "-");
    if (lower.includes(`@${label}`) || lower.includes(`@${slug}`) || lower.includes(`@${id}`)) return true;
    if (label.length < 3) return false;
    return new RegExp(`(^|[^a-z0-9])${escapeRegex(label)}([^a-z0-9]|$)`, "i").test(text);
  });
}

function componentHints(text, components) {
  const match = text.match(/@([a-zA-Z0-9_.-]*)$/);
  if (!match) return componentMentions(text, components).slice(0, 4);
  const q = match[1].toLowerCase();
  return components
    .filter((component) => {
      const label = (component.label || "").toLowerCase();
      const id = (component.id || "").toLowerCase();
      return label.includes(q) || id.includes(q);
    })
    .slice(0, 5);
}

function suggestionFor(text, components, fallbackKind) {
  const kind = inferKind(text, fallbackKind);
  return {
    kind,
    priority: inferPriority(text, kind),
    refs: componentMentions(text, components).map((component) => component.id),
  };
}

function noteText(note) {
  return [note.title || "", note.body || ""].filter(Boolean).join("\n");
}

function notesBrief(notes) {
  const recent = (notes || []).slice(-10);
  if (!recent.length) return "none";
  return recent.map((note) => {
    const priority = note.priority ? `/${note.priority}` : "";
    const refs = (note.refs || []).map((ref) => ref.ref).filter(Boolean);
    return `- [${note.kind}${priority}] ${noteText(note)}${refs.length ? ` (refs: ${refs.join(", ")})` : ""}`;
  }).join("\n");
}

function componentBrief(components) {
  const topLevel = components.filter((component) => !component.parent);
  if (!topLevel.length) return "none";
  return topLevel
    .map((component) => `${component.label}(${component.type || component.kind}, ${component.plane || "execution"})`)
    .join(", ");
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

// A free-form notebook for requirements, ideas, decisions, questions, and
// risks. The user writes rough text; we infer structure so plan.md/handoff keep
// receiving clean note records.
export default function NotesPanel({ spec, commit, busy = false, onSend, onSuggest }) {
  const [filter, setFilter] = useState("all");
  const [draft, setDraft] = useState("");
  const [kindOverride, setKindOverride] = useState(null);
  const [priorityOverride, setPriorityOverride] = useState(null);
  const [refOverrides, setRefOverrides] = useState([]);
  const notes = spec.notes || [];
  const components = spec.views.architecture.nodes;
  const shown = filter === "all" ? notes : notes.filter((n) => n.kind === filter);
  const items = useMemo(() => draftItems(draft), [draft]);
  const inferred = useMemo(() => suggestionFor(draft, components, filter), [draft, components, filter]);
  const draftKind = kindOverride || inferred.kind;
  const draftPriority = priorityOverride || inferred.priority;
  const draftRefs = unique([...inferred.refs, ...refOverrides]);
  const hints = useMemo(() => componentHints(draft, components), [draft, components]);

  const update = (id, patch) => commit(applyMutation(spec, { op: "update_note", id, ...patch }));
  const remove = (id) => commit(applyMutation(spec, { op: "remove_note", id }));

  const resetDraft = () => {
    setDraft("");
    setKindOverride(null);
    setPriorityOverride(null);
    setRefOverrides([]);
  };

  const capture = () => {
    if (!items.length) return;
    let next = spec;
    for (const item of items) {
      const itemSuggestion = suggestionFor(item, components, filter);
      const kind = kindOverride || itemSuggestion.kind;
      const priority = priorityOverride || itemSuggestion.priority;
      const refs = unique([...itemSuggestion.refs, ...refOverrides]).map((ref) => ({ view: "architecture", ref }));
      const { title, body } = parseNoteText(item);
      if (!title && !body) continue;
      next = applyMutation(next, {
        op: "add_note",
        kind,
        title,
        body,
        priority: isReq(kind) ? priority : null,
        refs,
      });
    }
    commit(next);
    resetDraft();
  };

  const askAssistant = () => {
    const text = draft.trim();
    if (!text || busy || !onSend) return;
    onSend(`Turn this rough architecture note into structured Notes entries. Use add_note for each requirement, decision, question, idea, or risk; infer priority and refs when obvious.\n\n${text}`);
    resetDraft();
  };

  const proposeDiagram = () => {
    if (busy || !onSuggest) return;
    const text = draft.trim();
    const noteSeed = text || notes.slice(-6).map(noteText).filter(Boolean).join("\n");
    if (!noteSeed) return;
    const inferredText = text
      ? `Draft inference: kind=${draftKind}${draftPriority ? `, priority=${draftPriority}` : ""}${draftRefs.length ? `, refs=${draftRefs.join(", ")}` : ""}`
      : "";
    onSuggest({
      idea: `Turn rough notes into a proposed architecture diagram:\n${noteSeed}`,
      context: [
        "Treat these notes as a loose design brief, not a form submission.",
        "Start with a freeform Mermaid sketch so the user can inspect the idea before accepting the structured canvas change.",
        "Autocomplete missing architecture responsibilities only when the notes imply them.",
        "Return one small proposed diagram change; do not directly mutate the canvas.",
        "Prefer reusing, renaming, annotating, or rewiring existing components before adding boxes.",
        inferredText,
        `Current top-level components:\n${componentBrief(components)}`,
        `Recent captured notes:\n${notesBrief(notes)}`,
      ].filter(Boolean).join("\n\n"),
    });
  };

  const setFreeText = (note, value) => {
    const { title, body } = parseNoteText(value);
    update(note.id, { title, body });
  };

  const setRef = (note, ref) => {
    const refs = ref ? [{ view: "architecture", ref }] : [];
    update(note.id, { refs });
  };

  return (
    <div className="notes-panel">
      <div className="notes-filters">
        <button className={`notes-chip ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>All</button>
        {NOTE_KINDS.map((k) => (
          <button key={k.id} className={`notes-chip ${filter === k.id ? "on" : ""}`} onClick={() => setFilter(k.id)}>{k.label}</button>
        ))}
      </div>

      <div className="notes-composer">
        <textarea
          className="notes-compose-input"
          rows={5}
          value={draft}
          placeholder="Type or paste rough notes..."
          onChange={(e) => {
            setDraft(e.target.value);
            if (!e.target.value.trim()) {
              setKindOverride(null);
              setPriorityOverride(null);
              setRefOverrides([]);
            }
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              capture();
            }
          }}
        />

        {draft.trim() && (
          <div className="note-suggestions">
            {NOTE_KINDS.map((kind) => (
              <button
                key={kind.id}
                className={`note-pill kind-${kind.id} ${draftKind === kind.id ? "on" : ""}`}
                onClick={() => {
                  setKindOverride(kind.id);
                  if (!isReq(kind.id)) setPriorityOverride(null);
                }}
              >
                {kind.label}
              </button>
            ))}
            {isReq(draftKind) && (
              NOTE_PRIORITIES.map((priority) => (
                <button
                  key={priority}
                  className={`note-pill ${draftPriority === priority ? "on" : ""}`}
                  onClick={() => setPriorityOverride(priority)}
                >
                  {priority}
                </button>
              ))
            )}
            {hints.map((component) => (
              <button
                key={component.id}
                className={`note-pill ${draftRefs.includes(component.id) ? "on" : ""}`}
                onClick={() => setRefOverrides((refs) => unique([...refs, component.id]))}
              >
                @{component.label}
              </button>
            ))}
          </div>
        )}

        <div className="notes-compose-actions">
          <button className="mini-btn" onClick={proposeDiagram} disabled={busy || !onSuggest || (!draft.trim() && !notes.length)}>
            Propose diagram
          </button>
          <button className="btn" onClick={capture} disabled={!items.length}>
            {items.length > 1 ? `Capture ${items.length}` : "Capture"}
          </button>
          <button className="mini-btn" onClick={askAssistant} disabled={!draft.trim() || busy || !onSend}>
            Ask AI
          </button>
        </div>
      </div>

      <div className="notes-scroll">
        {shown.length === 0 && <div className="notes-empty">No notes yet.</div>}
        {shown.map((n) => (
          <div className={`note note-${n.kind}`} key={n.id}>
            <div className="note-head note-head-free">
              <select value={n.kind} onChange={(e) => update(n.id, { kind: e.target.value, priority: isReq(e.target.value) ? n.priority : null })}>
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
            <textarea
              className="note-free-text"
              rows={Math.max(2, Math.min(8, noteText(n).split(/\r?\n/).length + 1))}
              placeholder="Untitled note"
              value={noteText(n)}
              onChange={(e) => setFreeText(n, e.target.value)}
            />
            <div className="note-ref-row">
              {(n.refs || []).map((ref) => {
                const component = components.find((c) => c.id === ref.ref);
                return component ? <span className="note-ref-pill" key={ref.ref}>@{component.label}</span> : null;
              })}
              <select className="note-ref-add" value={n.refs?.[0]?.ref || ""} onChange={(e) => setRef(n, e.target.value)}>
                <option value="">link</option>
                {components.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
