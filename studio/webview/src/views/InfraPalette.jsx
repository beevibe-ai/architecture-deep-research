import React, { useState, useMemo } from "react";
import { INFRA_GROUPS, infraTypesByGroup } from "../../../shared/infra.mjs";

// Infrastructure palette: k8s + cloud + serving + build component types, grouped
// and searchable. Drag onto the canvas; dropping inside a container (cluster,
// namespace, node pool, workload) nests it there.
export default function InfraPalette() {
  const [q, setQ] = useState("");
  const byGroup = useMemo(() => infraTypesByGroup(), []);
  const needle = q.trim().toLowerCase();
  return (
    <aside className="palette catalog-palette">
      <input className="cat-search" placeholder="Search infra…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="cat-scroll">
        {INFRA_GROUPS.map((g) => {
          const types = (byGroup[g.id] || []).filter((t) => !needle || t.id.includes(needle) || t.label.toLowerCase().includes(needle));
          if (!types.length) return null;
          return (
            <div className="cat-group" key={g.id}>
              <div className="cat-group-head">{g.label}</div>
              {types.map((t) => (
                <div
                  key={t.id}
                  className="cat-chip"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/adr-infra", t.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                >
                  <span className="cat-chip-label">{t.label}</span>
                  {t.level !== "leaf" && <span className="cat-plane cp-control">▣</span>}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
