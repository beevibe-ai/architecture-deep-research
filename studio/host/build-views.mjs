// Build the full multi-view system from an inferred architecture + a repo scan.
// Every view is reverse-engineered from its REAL source where one exists (SQL
// migrations → data model, docker-compose / k8s → infra), and only projected
// from the architecture when no real source does. Shared by the extension host
// and the debug CLI so the terminal and VS Code produce identical specs.
import { applyMutation } from "../shared/ir.mjs";
import { infraFromCompose, infraFromK8s, dataModelFromSql, classesFromSource } from "./extract.mjs";

export function buildAllViews(archSpec, scan) {
  let full = archSpec;
  const apply = (m) => { try { full = applyMutation(full, m); } catch { /* skip a mutation that can't apply */ } };

  // Infra ← docker-compose / k8s manifests.
  const infraMuts = [];
  for (const c of scan.deploy_configs || []) {
    if (!c.content) continue;
    if (/docker-compose/.test(c.path)) infraMuts.push(...infraFromCompose(c.content, c.path));
    else if (/(^|\/)(k8s|kubernetes|helm|charts)\//.test(c.path) || /\bkind:\s/.test(c.content)) infraMuts.push(...infraFromK8s(c.content, c.path));
  }
  if (infraMuts.length) {
    infraMuts.forEach(apply);
    apply({ op: "auto_layout", view: "infra" });
    // Link each real infra node back to the architecture component it deploys
    // (traceability), matching on normalized label containment.
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const inf of full.views.infra.nodes) {
      if (inf.parent) continue;
      const comp = full.views.architecture.nodes.find((n) => !n.parent && (norm(n.label).includes(norm(inf.label)) || norm(inf.label).includes(norm(n.label))));
      if (comp) apply({ op: "realize", component: comp.label, infra: inf.label });
    }
  } else apply({ op: "derive", view: "infra" });

  // Data model ← SQL migrations / schema files.
  const schema = scan.schema_sources || [];
  if (schema.length) { dataModelFromSql(schema).forEach(apply); apply({ op: "auto_layout", view: "data_model" }); }
  else apply({ op: "derive", view: "data_model" });

  // Classes ← real TS/JS/Python source (declarations + inheritance/implements).
  const classSrc = scan.class_sources || [];
  const classMuts = classSrc.length ? classesFromSource(classSrc) : [];
  if (classMuts.length) { classMuts.forEach(apply); apply({ op: "auto_layout", view: "classes" }); }
  else apply({ op: "derive", view: "classes" });

  // Sequences: still projected from the architecture (real call-trace is Stage C).
  apply({ op: "derive", view: "sequences" });
  return full;
}
