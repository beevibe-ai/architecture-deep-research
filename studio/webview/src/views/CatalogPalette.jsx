import React, { useState, useMemo } from "react";
import { CATEGORIES, PLANES, typesByCategory } from "../../../shared/catalog.mjs";

const PLANE_LABEL = Object.fromEntries(PLANES.map((p) => [p.id, p.label]));
const PLANE_BADGE = { control: "Control", execution: "Exec", data: "Data" };

// Catalog-driven palette: every component type the design language knows,
// grouped by category and searchable. Drag a chip onto the canvas — it carries
// its catalog type, which sets category/plane/tech on drop.
export default function CatalogPalette({ catalog }) {
  const [q, setQ] = useState("");
  const byCat = useMemo(() => typesByCategory(catalog), [catalog]);
  const needle = q.trim().toLowerCase();

  return (
    <aside className="palette catalog-palette">
      <input className="cat-search" placeholder="Search components…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="cat-scroll">
        {CATEGORIES.map((cat) => {
          const types = (byCat[cat.id] || []).filter(
            (t) => !needle || t.id.includes(needle) || t.label.toLowerCase().includes(needle)
          );
          if (!types.length) return null;
          return (
            <div className="cat-group" key={cat.id}>
              <div className="cat-group-head" style={{ color: cat.color }}>{cat.label}</div>
              {types.map((t) => (
                <div
                  key={t.id}
                  className="cat-chip"
                  draggable
                  title={`${PLANE_LABEL[t.plane] || t.plane}${t.tech?.length ? ` · tech: ${t.tech.join(", ")}` : ""}`}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/adr-type", t.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                >
                  <span className="cat-dot" style={{ background: cat.color }} />
                  <span className="cat-chip-label">{t.label}</span>
                  <span className={`cat-plane cp-${t.plane}`} title={PLANE_LABEL[t.plane] || t.plane}>
                    {PLANE_BADGE[t.plane] || t.plane}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
