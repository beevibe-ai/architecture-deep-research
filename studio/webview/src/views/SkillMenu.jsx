import React from "react";
import { applyMutation } from "../../../shared/ir.mjs";
import { SKILLS } from "../../../shared/skills.mjs";

// A per-view starter dropdown: applies a skill (a coherent, laid-out subgraph)
// so no view is ever a blank page you have to populate by hand.
export default function SkillMenu({ view, spec, commit, label = "+ Starter…" }) {
  const skills = SKILLS.filter((s) => s.view === view);
  if (!skills.length) return null;
  return (
    <select
      className="mini-btn skill-select"
      value=""
      onChange={(e) => {
        if (e.target.value) commit(applyMutation(spec, { op: "apply_skill", skill: e.target.value }));
        e.target.value = "";
      }}
    >
      <option value="">{label}</option>
      {skills.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
    </select>
  );
}
