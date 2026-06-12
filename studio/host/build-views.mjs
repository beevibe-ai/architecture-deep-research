// Build the full multi-view system from an inferred architecture + a repo scan.
// Every view is reverse-engineered from its REAL source where one exists (SQL
// migrations → data model, docker-compose / k8s → infra), and only projected
// from the architecture when no real source does. Shared by the extension host
// and the debug CLI so the terminal and VS Code produce identical specs.
import { applyMutation } from "../shared/ir.mjs";
import { repairCollapsedLayouts } from "../shared/layout.mjs";
import {
  infraFromCompose,
  infraFromK8s,
  dataModelFromSql,
  classesFromSource,
  flowsFromRoutes,
  sequencesFromRoutes,
} from "./extract.mjs";

export function buildAllViews(archSpec, scan) {
  let full = archSpec;
  const apply = (m) => { try { full = applyMutation(full, m); } catch { /* skip a mutation that can't apply */ } };
  repairCollapsedLayouts(full, ["architecture"]);

  // Infra ← docker-compose / k8s manifests.
  const infraMuts = [];
  for (const c of scan.deploy_configs || []) {
    if (!c.content) continue;
    if (/docker-compose/.test(c.path)) infraMuts.push(...infraFromCompose(c.content, c.path));
    else if (/(^|\/)(k8s|kubernetes|helm|charts)\//.test(c.path) || /\bkind:\s/.test(c.content)) infraMuts.push(...infraFromK8s(c.content, c.path));
  }
  if (infraMuts.length) {
    infraMuts.forEach(apply);
    // Link each real infra node back to the architecture component it deploys
    // (traceability), matching on normalized label containment.
    for (const inf of full.views.infra.nodes) {
      if (inf.parent) continue;
      const comp = full.views.architecture.nodes.find((n) => !n.parent && sameThing(n.label, inf.label));
      if (comp) apply({ op: "realize", component: comp.label, infra: inf.label });
    }
    addMissingDeployGaps(full).forEach(apply);
    apply({ op: "auto_layout", view: "infra" });
  } else apply({ op: "derive", view: "infra" });

  // Data model ← SQL migrations / schema files.
  const schema = scan.schema_sources || [];
  if (schema.length) { dataModelFromSql(schema).forEach(apply); apply({ op: "auto_layout", view: "data_model" }); }
  else apply({ op: "derive", view: "data_model" });

  // Flows ← real API route handlers (endpoint, auth, validation, deps, SQL).
  const routeSrc = scan.route_sources || [];
  const flowMuts = routeSrc.length ? flowsFromRoutes(routeSrc) : [];
  if (flowMuts.length) { flowMuts.forEach(apply); apply({ op: "auto_layout", view: "flows" }); }

  // Classes ← real TS/JS/Python source (declarations + inheritance/implements).
  const classSrc = scan.class_sources || [];
  const classMuts = classSrc.length ? classesFromSource(classSrc) : [];
  if (classMuts.length) { classMuts.forEach(apply); apply({ op: "auto_layout", view: "classes" }); }
  else apply({ op: "derive", view: "classes" });

  // Sequences ← real API route handlers. If a repo has no recognizable route
  // source, fall back to architecture wiring so the view is never blank.
  const sequenceMuts = routeSrc.length ? sequencesFromRoutes(routeSrc) : [];
  if (sequenceMuts.length) sequenceMuts.forEach(apply);
  else apply({ op: "derive", view: "sequences" });
  return full;
}

function addMissingDeployGaps(spec) {
  const realized = new Set(
    (spec.cross_refs || [])
      .filter((x) => x.kind === "deployed_as" && x.from.view === "architecture")
      .map((x) => x.from.ref)
  );
  const muts = [];
  for (const c of spec.views.architecture.nodes) {
    if (c.parent || realized.has(c.id)) continue;
    if (c.kind === "client" || c.kind === "external") continue;
    muts.push({
      op: "add_infra",
      view: "infra",
      type: "deploy_gap",
      label: c.label,
      props: {
        source: "architecture",
        component: c.label,
        reason: "No docker-compose/k8s resource found",
      },
    });
    muts.push({
      op: "link",
      from: { view: "architecture", ref: c.id },
      to: { view: "infra", ref: c.label },
      kind: "runs_on",
    });
  }
  return muts;
}

function sameThing(a, b) {
  const x = norm(a), y = norm(b);
  return x && y && (x.includes(y) || y.includes(x));
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
