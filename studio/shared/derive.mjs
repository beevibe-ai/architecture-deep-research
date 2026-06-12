// Derivation — project the architecture (the source of truth) into the other
// views, so they coordinate with it instead of being blank canvases. Each
// deriver returns idempotent mutations: it adds what's missing and links back to
// the architecture via cross_refs, leaving existing/refined elements alone.

// Map a logical component to its natural infra realization.
function infraFor(node) {
  const k = node.kind, t = node.type;
  if (k === "datastore") {
    if (t === "relational_db") return { type: "managed_postgres", cloud: true };
    if (t === "kv_store" || t === "cache") return { type: "elasticache", cloud: true };
    return { type: "statefulset", cloud: false }; // vector_db / search_index / ledger
  }
  if (k === "queue") return { type: "managed_kafka", cloud: true };
  if (k === "client" || k === "external") return null; // not deployed
  if (k === "gateway") return { type: "deployment", cloud: false, service: true };
  return { type: "deployment", cloud: false, service: true }; // service / compute / agent_harness
}

// Architecture → Infrastructure: a deployment/managed resource per component,
// linked with a deployed_as cross_ref. Skips components already deployed.
function deriveInfra(spec) {
  const arch = spec.views.architecture.nodes;
  const infra = spec.views.infra.nodes;
  const muts = [];
  const represented = new Set(
    (spec.cross_refs || [])
      .filter((x) => (x.kind === "deployed_as" || x.kind === "runs_on") && x.from.view === "architecture")
      .map((x) => x.from.ref)
  );
  const representedLabels = new Set(
    infra.flatMap((n) => [n.label, n.props?.component]).filter(Boolean).map((x) => String(x).toLowerCase())
  );
  const candidates = [];
  for (const c of arch) {
    if (c.parent) continue; // skip nested internals (the runtime maps as a whole)
    if (represented.has(c.id) || representedLabels.has(String(c.label).toLowerCase())) continue;
    const map = infraFor(c);
    if (map) candidates.push({ component: c, map });
  }

  const haveCluster = infra.some((n) => n.type === "cluster");
  if (!haveCluster && candidates.some(({ map }) => !map.cloud)) {
    muts.push({ op: "add_infra", view: "infra", type: "cluster", label: "cluster" });
    muts.push({ op: "add_infra", view: "infra", type: "namespace", label: "app", parent: "cluster", props: { name: "app" } });
  }
  for (const { component: c, map } of candidates) {
    const label = c.label;
    muts.push({ op: "add_infra", view: "infra", type: map.type, label, ...(map.cloud ? {} : { parent: "app" }), props: map.cloud ? {} : { image: `${slug(label)}:latest` } });
    muts.push({ op: "realize", component: c.label, infra: label }); // deployed_as cross_ref
    if (map.service) {
      muts.push({ op: "add_infra", view: "infra", type: "service", label: `${label} svc`, parent: "app" });
      muts.push({ op: "connect_infra", view: "infra", from: `${label} svc`, to: label, kind: "exposes" });
    }
  }
  return muts;
}

// Architecture → Data Model: an entity per datastore component, owned by it.
function deriveDataModel(spec) {
  const arch = spec.views.architecture.nodes;
  const muts = [];
  const owned = new Set(
    (spec.cross_refs || []).filter((x) => x.kind === "owns" && x.from.view === "architecture").map((x) => x.from.ref)
  );
  for (const c of arch) {
    if (c.kind !== "datastore" || owned.has(c.id)) continue;
    const name = entityName(c.label);
    muts.push({ op: "add_entity", view: "data_model", name, fields: [{ name: "id", type: "uuid", pk: true, nullable: false }] });
    muts.push({ op: "link", from: { view: "architecture", ref: c.id }, to: { view: "data_model", ref: name }, kind: "owns" });
  }
  return muts;
}

// Architecture → Sequence: the wiring as a runnable interaction.
function deriveSequence(spec) {
  const arch = spec.views.architecture;
  if (spec.views.sequences.some((s) => s.name === "Interactions")) return []; // already derived
  if (arch.edges.length === 0) return [];
  const byId = new Map(arch.nodes.map((n) => [n.id, n]));
  const involved = [];
  for (const e of arch.edges) {
    for (const id of [e.from, e.to]) {
      const n = byId.get(id);
      if (n && !n.parent && !involved.find((x) => x.id === id)) involved.push(n);
    }
  }
  const muts = [{ op: "add_sequence", view: "sequences", name: "Interactions" }];
  for (const n of involved) muts.push({ op: "add_participant", view: "sequences", seq: "Interactions", label: n.label });
  for (const e of arch.edges) {
    const from = byId.get(e.from), to = byId.get(e.to);
    if (!from || !to || from.parent || to.parent) continue;
    muts.push({ op: "add_message", view: "sequences", seq: "Interactions", from: from.label, to: to.label, label: e.label || e.kind, type: "sync" });
  }
  return muts;
}

// Architecture → Class: a class per service/harness component.
function deriveClasses(spec) {
  const arch = spec.views.architecture.nodes;
  const existing = new Set(spec.views.classes.nodes.map((c) => c.name.toLowerCase()));
  const muts = [];
  for (const c of arch) {
    if (c.parent) continue;
    if (!["service", "gateway"].includes(c.kind) && c.category !== "agent_harness") continue;
    const name = className(c.label);
    if (existing.has(name.toLowerCase())) continue;
    muts.push({ op: "add_class", view: "classes", name, members: [{ kind: "method", name: "handle()", type: "Result" }] });
  }
  return muts;
}

export function buildDerivation(view, spec) {
  if (view === "infra") return deriveInfra(spec);
  if (view === "data_model") return deriveDataModel(spec);
  if (view === "sequences") return deriveSequence(spec);
  if (view === "classes") return deriveClasses(spec);
  return [];
}

export const DERIVABLE_VIEWS = ["infra", "data_model", "sequences", "classes"];

// ---- helpers ----
const slug = (s) => String(s || "app").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const entityName = (label) => String(label || "Entity").replace(/\s+/g, "");
const className = (label) => String(label || "Class").replace(/\s+/g, "");
