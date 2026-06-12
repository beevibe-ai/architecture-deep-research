// Deterministic extractors — turn real repo source into real diagrams.
//
// Instead of projecting the data model and infra from the architecture (thin: one
// entity per datastore, a generic deployment per service), we parse the actual
// sources: SQL migrations → entities with real columns and foreign-key relations;
// docker-compose / k8s → the real services, images, volumes, and dependencies.
// Pure functions returning IR mutations (the same applyMutation path everything
// else uses), so the result is grounded in real files — no LLM, no hallucination.
import yaml from "js-yaml";

// ─────────────────────────────────────────────────────────────────────────────
// SQL → data model
// ─────────────────────────────────────────────────────────────────────────────

// Postgres/SQL type → data-model field type.
function dmType(sqlType) {
  const t = String(sqlType || "").toLowerCase();
  if (/^(text|varchar|char|citext|name)/.test(t)) return "text";
  if (/^(uuid)/.test(t)) return "uuid";
  if (/^(int|integer|bigint|smallint|serial|bigserial)/.test(t)) return "int";
  if (/^(bool)/.test(t)) return "bool";
  if (/^(timestamp|timestamptz|date|time)/.test(t)) return "timestamp";
  if (/^(json|jsonb)/.test(t)) return "json";
  if (/^(numeric|decimal|real|double|float)/.test(t)) return "float";
  if (/^(vector)/.test(t)) return "vector";
  if (/^(bytea|blob)/.test(t)) return "blob";
  return "text";
}

// Strip SQL comments (-- line and /* block */) and normalize whitespace lightly.
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

// Split a parenthesized table body into top-level items (commas at paren depth 0).
function splitTopLevel(body) {
  const items = [];
  let depth = 0, cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { items.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

// Find the balanced-paren body of `CREATE TABLE name ( ... )`. Returns
// { name, body, end } or null.
function readCreateTable(sql, from) {
  const m = /create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_.]+)"?\s*\(/i.exec(sql.slice(from));
  if (!m) return null;
  const open = from + m.index + m[0].length - 1; // index of "("
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") { depth--; if (depth === 0) return { name: unqualify(m[1]), body: sql.slice(open + 1, i), end: i }; }
  }
  return null;
}

const unqualify = (n) => String(n).replace(/^.*\./, "").replace(/"/g, "");
const CONSTRAINT_KW = /^(primary\s+key|foreign\s+key|unique|check|constraint|exclude|like)\b/i;

// Parse one CREATE TABLE into { name, fields, relations }.
function parseTable(name, body) {
  const fields = [];
  const relations = []; // { to, fk_field }
  const pkCols = new Set();

  for (const item of splitTopLevel(body)) {
    if (CONSTRAINT_KW.test(item)) {
      const pk = /^primary\s+key\s*\(([^)]+)\)/i.exec(item);
      if (pk) pk[1].split(",").forEach((c) => pkCols.add(c.trim().replace(/"/g, "")));
      const fk = /foreign\s+key\s*\(\s*"?([a-z0-9_]+)"?\s*\)\s*references\s+"?([a-z0-9_.]+)"?/i.exec(item);
      if (fk) relations.push({ to: unqualify(fk[2]), fk_field: fk[1] });
      continue;
    }
    const cm = /^"?([a-z0-9_]+)"?\s+([a-z0-9_]+(?:\s*\([^)]*\))?)/i.exec(item);
    if (!cm) continue;
    const col = cm[1];
    const field = {
      name: col,
      type: dmType(cm[2]),
      pk: /\bprimary\s+key\b/i.test(item),
      nullable: !/\bnot\s+null\b/i.test(item),
    };
    if (field.pk) pkCols.add(col);
    fields.push(field);
    const ref = /\breferences\s+"?([a-z0-9_.]+)"?/i.exec(item);
    if (ref) relations.push({ to: unqualify(ref[1]), fk_field: col });
  }
  for (const f of fields) if (pkCols.has(f.name)) f.pk = true;
  return { name, fields, relations };
}

// Parse `ALTER TABLE t ADD COLUMN c TYPE …` so later migrations enrich entities.
function parseAlterAdds(sql) {
  const adds = [];
  const re = /alter\s+table\s+(?:if\s+exists\s+)?"?([a-z0-9_.]+)"?\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?\s+([a-z0-9_]+(?:\s*\([^)]*\))?)([^;]*)/gi;
  let m;
  while ((m = re.exec(sql))) {
    adds.push({
      table: unqualify(m[1]),
      field: { name: m[2], type: dmType(m[3]), pk: /\bprimary\s+key\b/i.test(m[4]), nullable: !/\bnot\s+null\b/i.test(m[4]) },
      ref: (/\breferences\s+"?([a-z0-9_.]+)"?/i.exec(m[4]) || [])[1],
    });
  }
  return adds;
}

// Build data-model IR mutations from one or more SQL sources (migrations).
// Pass an array of { path, content } so relations across files resolve and the
// cumulative schema (CREATE + later ALTER ADD COLUMN) is captured.
export function dataModelFromSql(sources) {
  const tables = new Map(); // name → { name, fields, relations, cite }
  for (const src of sources) {
    const sql = stripSqlComments(src.content || "");
    let i = 0, ct;
    while ((ct = readCreateTable(sql, i))) {
      const t = parseTable(ct.name, ct.body);
      t.cite = src.path;
      tables.set(t.name, t);
      i = ct.end + 1;
    }
    for (const a of parseAlterAdds(sql)) {
      const t = tables.get(a.table);
      if (!t) continue;
      if (!t.fields.some((f) => f.name === a.field.name)) t.fields.push(a.field);
      if (a.ref) t.relations.push({ to: unqualify(a.ref), fk_field: a.field.name });
    }
  }

  const muts = [];
  const names = new Set(tables.keys());
  for (const t of tables.values()) {
    muts.push({ op: "add_entity", view: "data_model", name: t.name, context: t.cite, fields: t.fields });
  }
  // Relations: a FK row references one parent → parent 1:N child.
  for (const t of tables.values()) {
    for (const rel of t.relations) {
      if (!names.has(rel.to)) continue; // only real targets
      muts.push({ op: "add_relation", view: "data_model", from: rel.to, to: t.name, cardinality: "1:N", label: rel.fk_field });
    }
  }
  return muts;
}

// ─────────────────────────────────────────────────────────────────────────────
// docker-compose / k8s → infrastructure
// ─────────────────────────────────────────────────────────────────────────────

// A container image that is really a datastore/broker → a stateful node.
function infraTypeForImage(image) {
  const i = String(image || "").toLowerCase();
  if (/postgres|pgvector|mysql|mariadb|mongo|redis|cassandra|clickhouse|cockroach/.test(i)) return "statefulset";
  if (/kafka|rabbitmq|nats|zookeeper/.test(i)) return "statefulset";
  return "deployment";
}

// Build infra IR mutations from a docker-compose file.
export function infraFromCompose(text, filePath) {
  let doc;
  try { doc = yaml.load(text); } catch { return []; }
  if (!doc || typeof doc !== "object" || !doc.services) return [];
  const muts = [];
  const services = doc.services;
  const cite = filePath;

  for (const [name, svc = {}] of Object.entries(services)) {
    const ports = (svc.ports || []).map(String).join(", ");
    muts.push({
      op: "add_infra", view: "infra", type: infraTypeForImage(svc.image),
      label: name,
      props: { image: svc.image || "", ...(ports ? { ports } : {}), source: cite },
    });
    // A published port means the service is reachable → model the Service fronting it.
    if (ports) {
      muts.push({ op: "add_infra", view: "infra", type: "service", label: `${name}-svc`, props: { ports, source: cite } });
      muts.push({ op: "connect_infra", view: "infra", from: `${name}-svc`, to: name, kind: "exposes" });
    }
  }
  // Volumes referenced by a service → a PVC + mount edge.
  for (const [name, svc = {}] of Object.entries(services)) {
    for (const v of svc.volumes || []) {
      const vol = String(v).split(":")[0];
      if (!vol || vol.startsWith("/") || vol.startsWith(".")) continue; // bind mount, skip
      muts.push({ op: "add_infra", view: "infra", type: "pvc", label: vol, props: { source: cite } });
      muts.push({ op: "connect_infra", view: "infra", from: name, to: vol, kind: "mounts" });
    }
  }
  // depends_on → an edge (the dependency backs the dependent).
  for (const [name, svc = {}] of Object.entries(services)) {
    const deps = Array.isArray(svc.depends_on) ? svc.depends_on : Object.keys(svc.depends_on || {});
    for (const dep of deps) if (services[dep]) muts.push({ op: "connect_infra", view: "infra", from: dep, to: name, kind: "backs" });
  }
  return muts;
}

// ─────────────────────────────────────────────────────────────────────────────
// TS/JS source → class diagram
// ─────────────────────────────────────────────────────────────────────────────

const CONTROL_KW = new Set(["if", "for", "while", "switch", "catch", "return", "throw", "await", "yield", "else", "do", "new", "typeof", "function", "super", "const", "let", "var", "case", "default", "import", "export"]);

// Read the balanced-brace body starting at the `{` index `open`.
function readBraceBody(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) return { body: text.slice(open + 1, i), end: i }; }
  }
  return { body: text.slice(open + 1), end: text.length };
}

// Method names declared at the top level of a class/interface body (depth 0).
function membersOf(body) {
  const methods = [];
  let depth = 0;
  for (const line of body.split("\n")) {
    if (depth === 0) {
      const m = /^(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|override\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*[(<]/.exec(line.trim());
      if (m && !CONTROL_KW.has(m[1]) && !methods.includes(m[1])) methods.push(m[1]);
    }
    for (const ch of line) { if (ch === "{") depth++; else if (ch === "}") depth--; }
  }
  return methods.slice(0, 12);
}

const baseName = (t) => String(t).split(/[<.]/)[0].trim();

// Extract real classes + interfaces (with inheritance/implements edges) from
// TS/JS sources. Deterministic, grounded — no LLM.
export function classesFromSource(sources, { max = 90 } = {}) {
  const decls = []; // { name, stereotype, members, extends:[], implements:[], cite }
  const seen = new Set();

  for (const src of sources) {
    const text = src.content || "";
    // Classes.
    const classRe = /(?:export\s+)?(?:default\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([\w.<>, ]+?))?(?:\s+implements\s+([\w.<>, ]+?))?\s*\{/g;
    let m;
    while ((m = classRe.exec(text))) {
      const name = m[2];
      if (seen.has(name)) continue;
      seen.add(name);
      const { body } = readBraceBody(text, classRe.lastIndex - 1);
      decls.push({
        name, stereotype: m[1] ? "abstract" : null, members: membersOf(body), cite: src.path,
        extends: m[3] ? [baseName(m[3])] : [],
        implements: m[4] ? m[4].split(",").map(baseName).filter(Boolean) : [],
      });
    }
    // Interfaces (so `implements X` resolves to a real node).
    const ifaceRe = /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([\w.<>, ]+?))?\s*\{/g;
    while ((m = ifaceRe.exec(text))) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      const { body } = readBraceBody(text, ifaceRe.lastIndex - 1);
      decls.push({ name, stereotype: "interface", members: membersOf(body), cite: src.path, extends: m[2] ? m[2].split(",").map(baseName) : [], implements: [] });
    }
  }

  // Signal over noise: keep the concrete classes (real behavior), then only the
  // interfaces they actually extend/implement — so inheritance edges resolve and
  // the view isn't drowned in config/DTO interfaces.
  const classes = decls.filter((d) => d.stereotype !== "interface");
  const interfaces = decls.filter((d) => d.stereotype === "interface");
  const keptClasses = classes.slice(0, max);
  const referenced = new Set();
  for (const d of keptClasses) { d.extends.forEach((b) => referenced.add(b)); d.implements.forEach((i) => referenced.add(i)); }
  const kept = [...keptClasses, ...interfaces.filter((i) => referenced.has(i.name))];
  const names = new Set(kept.map((d) => d.name));
  const muts = [];
  for (const d of kept) {
    muts.push({ op: "add_class", view: "classes", name: d.name, stereotype: d.stereotype, context: d.cite, members: d.members.map((nm) => ({ kind: "method", name: `${nm}()` })) });
  }
  for (const d of kept) {
    for (const base of d.extends) if (names.has(base)) muts.push({ op: "connect_class", view: "classes", from: d.name, to: base, kind: "inherits" });
    for (const iface of d.implements) if (names.has(iface)) muts.push({ op: "connect_class", view: "classes", from: d.name, to: iface, kind: "implements" });
  }
  return muts;
}

// Build infra IR mutations from k8s manifests (possibly multi-doc YAML).
export function infraFromK8s(text, filePath) {
  let docs;
  try { docs = yaml.loadAll(text); } catch { return []; }
  const muts = [];
  const TYPE = { Deployment: "deployment", StatefulSet: "statefulset", DaemonSet: "daemonset", Service: "service", Ingress: "ingress", PersistentVolumeClaim: "pvc", CronJob: "cronjob", Job: "job" };
  for (const d of docs || []) {
    if (!d || !d.kind) continue;
    const t = TYPE[d.kind];
    if (!t) continue;
    muts.push({ op: "add_infra", view: "infra", type: t, label: d.metadata?.name || d.kind, props: { source: filePath } });
  }
  return muts;
}
