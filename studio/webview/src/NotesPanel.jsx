import React, { useMemo, useState } from "react";
import { applyMutation, NOTE_KINDS } from "../../shared/ir.mjs";

const KIND_LABEL = Object.fromEntries(NOTE_KINDS.map((k) => [k.id, k.label]));
const isReq = (kind) => kind === "functional" || kind === "non_functional";
const MAX_TITLE = 90;
const KIND_PREFIXES = new Map([
  ["req", "functional"],
  ["requirement", "functional"],
  ["functional", "functional"],
  ["nfr", "non_functional"],
  ["nonfunctional", "non_functional"],
  ["non-functional", "non_functional"],
  ["non functional", "non_functional"],
  ["idea", "idea"],
  ["question", "question"],
  ["decision", "decision"],
  ["risk", "risk"],
]);

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripPrefix(text) {
  return text
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")
    .replace(/^\s*(?:req|requirement|functional|nfr|non[-_\s]?functional|idea|question|decision|risk)\s*:\s*/i, "")
    .trim();
}

function explicitKindFrom(text) {
  const first = text.split(/\r?\n/).find((line) => line.trim()) || "";
  const plain = first.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "");
  const match = plain.match(/^\s*(req|requirement|functional|nfr|non[-_\s]?functional|idea|question|decision|risk)\s*:/i);
  if (!match) return null;
  return KIND_PREFIXES.get(match[1].toLowerCase().replace(/_/g, " ")) || null;
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
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  return bullets.length > 1 ? bullets : [raw];
}

function inferKind(text, fallback = "idea") {
  const lower = text.toLowerCase();
  if (/[?？]\s*$/.test(text) || /^(how|what|why|when|who|can|should|do we|does)\b/.test(lower)) return "question";
  if (/\b(risk|risky|concern|blocker|blocked|failure|fail|missing|unsafe|security hole)\b/.test(lower)) return "risk";
  if (/\b(p99|latency|throughput|scale|scaling|availability|reliability|secure|security|privacy|cost|slo|sla|observability)\b/.test(lower)) return "non_functional";
  if (/\b(must|need|needs|require|requires|required|should support|user can|users can|allow|enable)\b/.test(lower)) return "functional";
  if (/\b(decide|decided|decision|we will|use|choose|selected|standardize)\b/.test(lower)) return "decision";
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

function suggestionFor(text, components, fallbackKind) {
  const kind = explicitKindFrom(text) || inferKind(text, fallbackKind);
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

// A free-form notebook for requirements, ideas, decisions, questions, and
// risks. The user writes rough text; we infer structure so plan.md/handoff keep
// receiving clean note records.
export default function NotesPanel({ spec, commit, busy = false, onSend, onSuggest }) {
  const [filter, setFilter] = useState("all");
  const [draft, setDraft] = useState("");
  const notes = spec.notes || [];
  const components = spec.views.architecture.nodes;
  const shown = filter === "all" ? notes : notes.filter((n) => n.kind === filter);
  const draftHint = useMemo(() => suggestionFor(draft, components, filter), [draft, components, filter]);

  const update = (id, patch) => commit(applyMutation(spec, { op: "update_note", id, ...patch }));
  const remove = (id) => commit(applyMutation(spec, { op: "remove_note", id }));

  const clearDraft = () => {
    setDraft("");
  };

  const saveDraft = () => {
    const items = draftItems(draft);
    if (!items.length) return;
    let next = spec;
    for (const item of items) {
      const itemSuggestion = suggestionFor(item, components, filter);
      const kind = itemSuggestion.kind;
      const priority = itemSuggestion.priority;
      const refs = itemSuggestion.refs.map((ref) => ({ view: "architecture", ref }));
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
    clearDraft();
  };
  const onDraftBlur = (event) => {
    if (event.relatedTarget?.closest?.(".notes-composer")) return;
    saveDraft();
  };

  const askAssistant = () => {
    const text = draft.trim();
    if (!text || busy || !onSend) return;
    onSend(`Turn this rough architecture note into structured Notes entries. Use add_note for each requirement, decision, question, idea, or risk; infer priority and refs when obvious.\n\n${text}`);
    clearDraft();
  };

  const proposeDiagram = () => {
    if (busy || !onSuggest) return;
    const text = draft.trim();
    const noteSeed = text || notes.slice(-6).map(noteText).filter(Boolean).join("\n");
    if (!noteSeed) return;
    const inferredText = text
      ? `Draft inference: kind=${draftHint.kind}${draftHint.priority ? `, priority=${draftHint.priority}` : ""}${draftHint.refs.length ? `, refs=${draftHint.refs.join(", ")}` : ""}`
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
        `Recent notes:\n${notesBrief(notes)}`,
      ].filter(Boolean).join("\n\n"),
    });
  };

  const setFreeText = (note, value) => {
    if (!value.trim()) {
      update(note.id, { title: "", body: "" });
      return;
    }
    const { title, body } = parseNoteText(value);
    const explicitKind = explicitKindFrom(value);
    const mentionedRefs = componentMentions(value, components).map((component) => component.id);
    const patch = { title, body };
    if (explicitKind) {
      patch.kind = explicitKind;
      patch.priority = isReq(explicitKind) ? (inferPriority(value, explicitKind) || note.priority || null) : null;
    }
    if (/@[a-zA-Z0-9_.-]/.test(value)) {
      patch.refs = mentionedRefs.map((ref) => ({ view: "architecture", ref }));
    }
    update(note.id, patch);
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
          rows={Math.max(4, Math.min(12, draft.split(/\r?\n/).length + 1))}
          value={draft}
          placeholder="Write or paste rough notes..."
          onChange={(e) => setDraft(e.target.value)}
          onBlur={onDraftBlur}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              saveDraft();
            }
          }}
        />

        {draft.trim() && (
          <div className="notes-draft-meta">
            <span>{KIND_LABEL[draftHint.kind] || draftHint.kind}</span>
            {draftHint.priority ? <span>{draftHint.priority}</span> : null}
            {draftHint.refs.map((ref) => {
              const component = components.find((c) => c.id === ref);
              return component ? <span key={ref}>@{component.label}</span> : null;
            })}
          </div>
        )}

        <div className="notes-compose-actions">
          <button className="mini-btn" onMouseDown={(e) => e.preventDefault()} onClick={proposeDiagram} disabled={busy || !onSuggest || (!draft.trim() && !notes.length)}>
            Propose diagram
          </button>
          <button className="mini-btn" onMouseDown={(e) => e.preventDefault()} onClick={askAssistant} disabled={!draft.trim() || busy || !onSend}>
            Ask AI
          </button>
        </div>
      </div>

      <div className="notes-scroll">
        {shown.length === 0 && <div className="notes-empty">No notes yet.</div>}
        {shown.map((n) => (
          <div className={`note note-${n.kind}`} key={n.id}>
            <textarea
              className="note-free-text"
              rows={Math.max(1, Math.min(12, noteText(n).split(/\r?\n/).length + 1))}
              placeholder="Untitled note"
              value={noteText(n)}
              onChange={(e) => setFreeText(n, e.target.value)}
              onBlur={() => { if (!noteText(n).trim()) remove(n.id); }}
            />
            <div className="note-block-meta">
              <span className={`note-kind-tag note-kind-${n.kind}`}>{KIND_LABEL[n.kind] || n.kind}</span>
              {n.priority ? <span className="note-priority-tag">{n.priority}</span> : null}
              {(n.refs || []).map((ref) => {
                const component = components.find((c) => c.id === ref.ref);
                return component ? <span className="note-ref-pill" key={ref.ref}>@{component.label}</span> : null;
              })}
              <button className="mini-btn ghost note-delete" onClick={() => remove(n.id)}>×</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
