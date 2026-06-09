import React, { useState, useMemo } from "react";
import { CATEGORIES, typesByCategory } from "../../../shared/catalog.mjs";

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
                  title={t.tech?.length ? `tech: ${t.tech.join(", ")}` : t.label}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/adr-type", t.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                >
                  <span className="cat-dot" style={{ background: cat.color }} />
                  <span className="cat-chip-label">{t.label}</span>
                  <span className={`cat-plane cp-${t.plane}`}>{t.plane[0].toUpperCase()}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
