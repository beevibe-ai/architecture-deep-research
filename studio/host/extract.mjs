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
// Handles both one-column statements and comma-separated ADD COLUMN blocks.
function parseAlterAdds(sql) {
  const adds = [];
  const re = /alter\s+table\s+(?:if\s+exists\s+)?"?([a-z0-9_.]+)"?\s+([\s\S]*?);/gi;
  let m;
  while ((m = re.exec(sql))) {
    const table = unqualify(m[1]);
    for (const item of splitTopLevel(m[2])) {
      const add = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?\s+([a-z0-9_]+(?:\s*\([^)]*\))?)([\s\S]*)$/i.exec(item);
      if (!add) continue;
      adds.push({
        table,
        field: { name: add[1], type: dmType(add[2]), pk: /\bprimary\s+key\b/i.test(add[3]), nullable: !/\bnot\s+null\b/i.test(add[3]) },
        ref: (/\breferences\s+"?([a-z0-9_.]+)"?/i.exec(add[3]) || [])[1],
      });
    }
  }
  return adds;
}

// Parse `ALTER TABLE child ADD CONSTRAINT ... FOREIGN KEY (...) REFERENCES parent`.
function parseAlterForeignKeys(sql) {
  const fks = [];
  const re = /alter\s+table\s+(?:if\s+exists\s+)?"?([a-z0-9_.]+)"?\s+([\s\S]*?);/gi;
  let m;
  while ((m = re.exec(sql))) {
    const table = unqualify(m[1]);
    for (const item of splitTopLevel(m[2])) {
      const fk = /(?:add\s+)?(?:constraint\s+"?[a-z0-9_]+"?\s+)?foreign\s+key\s*\(\s*"?([a-z0-9_]+)"?\s*\)\s*references\s+"?([a-z0-9_.]+)"?/i.exec(item);
      if (fk) fks.push({ table, to: unqualify(fk[2]), fk_field: fk[1] });
    }
  }
  return fks;
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
    for (const fk of parseAlterForeignKeys(sql)) {
      const t = tables.get(fk.table);
      if (t) t.relations.push({ to: fk.to, fk_field: fk.fk_field });
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

// ─────────────────────────────────────────────────────────────────────────────
// Express / API source → flows + sequences
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function routePrefixForPath(filePath) {
  const p = String(filePath || "").replace(/\\/g, "/");
  if (/\/runtime\/router\.[tj]s$/.test(p)) return "/runtime";
  const m = /\/routes\/([^/.]+)\.[tj]s$/.exec(p);
  if (!m) return "";
  return {
    mcp: "/mcp",
    task: "/task",
    escalation: "/escalation",
    stream: "/api",
    chat: "/chat",
    runtimes: "/runtimes",
    room: "/room",
  }[m[1]] || "";
}

function joinRoute(prefix, route) {
  const p = String(prefix || "").replace(/\/+$/g, "");
  const r = String(route || "/").replace(/^\/+/g, "");
  if (!p && !r) return "/";
  if (!r) return p || "/";
  return `${p}/${r}`.replace(/\/+/g, "/");
}

function sqlOpsIn(text) {
  const clean = stripSqlComments(text || "");
  const ops = [];
  const patterns = [
    ["INSERT", /\binsert\s+into\s+"?([a-z0-9_]+)"?/gi],
    ["UPDATE", /\bupdate\s+(?!set\b)"?([a-z0-9_]+)"?/gi],
    ["DELETE", /\bdelete\s+from\s+"?([a-z0-9_]+)"?/gi],
    ["SELECT", /\bfrom\s+"?([a-z0-9_]+)"?/gi],
    ["JOIN", /\bjoin\s+"?([a-z0-9_]+)"?/gi],
  ];
  const seen = new Set();
  for (const [op, re] of patterns) {
    let m;
    while ((m = re.exec(clean))) {
      const table = m[1].toLowerCase();
      const key = `${op}:${table}`;
      if (!seen.has(key)) {
        seen.add(key);
        ops.push({ op, table });
      }
    }
  }
  return ops.slice(0, 12);
}

function dependencyCallsIn(text) {
  const deps = [];
  const seen = new Set();
  const add = (target, method) => {
    if (!target || !method || target === "pool") return;
    const key = `${target}.${method}`;
    if (!seen.has(key)) {
      seen.add(key);
      deps.push({ target, method });
    }
  };
  let m;
  const depsRe = /\bdeps\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = depsRe.exec(text))) add(m[1], m[2]);
  const repoRe = /\b([A-Za-z_$][\w$]*(?:Repo|Service|Manager|Hub|Resolver|Registry|Agent))\.([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = repoRe.exec(text))) add(m[1], m[2]);
  return deps.slice(0, 12);
}

function notificationsIn(text) {
  const out = [];
  const seen = new Set();
  const patterns = [
    /pg_notify\s*\(\s*['"`]([A-Za-z0-9_.:-]+)['"`]/g,
    /\bLISTEN\s+([A-Za-z0-9_.:-]+)/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
  }
  return out.slice(0, 8);
}

function hasAuthBefore(text, index) {
  return /router\.use\s*\(\s*deps\.authMiddleware\s*\)/.test(text.slice(0, index));
}

function isRouteLikePath(route) {
  return String(route || "").startsWith("/");
}

function routeScore(f) {
  return (
    (MUTATING_METHODS.has(f.method) ? 5 : 0) +
    (f.sql_ops?.length || 0) * 4 +
    (f.dependencies?.length || 0) * 2 +
    (f.notifications?.length || 0) * 3 +
    (f.auth ? 1 : 0)
  );
}

function selectedRoutes(facts, max) {
  return [...facts]
    .filter((f) => f.kind === "server_route")
    .sort((a, b) => routeScore(b) - routeScore(a) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
    .slice(0, max);
}

export function routeFactsFromSource(src) {
  const text = src.content || "";
  const file = src.path || "";
  const prefix = routePrefixForPath(file);
  const facts = [];
  const re = /\b(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*(["'`])([^"'`]+)\2\s*,/gi;
  let m;
  while ((m = re.exec(text))) {
    const method = m[1].toUpperCase();
    const localPath = m[3];
    if (!ROUTE_METHODS.has(method) || !isRouteLikePath(localPath)) continue;
    const open = text.indexOf("{", re.lastIndex);
    const semi = text.indexOf(";", re.lastIndex);
    const body = open >= 0 && (semi < 0 || open < semi) ? readBraceBody(text, open).body : "";
    facts.push({
      kind: "server_route",
      method,
      path: joinRoute(prefix, localPath),
      local_path: localPath,
      file,
      auth: hasAuthBefore(text, m.index) || /\brequire(?:Human|Daemon)\s*\(/.test(body),
      validation: /\bres\.status\s*\(\s*40[034]\s*\)|\binvalid_body\b|\bif\s*\([^)]*!/.test(body),
      sql_ops: sqlOpsIn(body),
      dependencies: dependencyCallsIn(body),
      notifications: notificationsIn(body),
    });
  }
  return facts;
}

export function routeFactsFromSources(sources) {
  const byKey = new Map();
  for (const src of sources || []) {
    for (const f of routeFactsFromSource(src)) {
      const key = `${f.method} ${f.path}`;
      const prev = byKey.get(key);
      if (!prev || routeScore(f) > routeScore(prev)) byKey.set(key, f);
    }
  }
  return [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function summarizeSqlOps(ops) {
  const byTable = new Map();
  for (const o of ops || []) {
    const set = byTable.get(o.table) || new Set();
    set.add(o.op);
    byTable.set(o.table, set);
  }
  return [...byTable.entries()].map(([table, verbs]) => `${[...verbs].join("/")} ${table}`);
}

function humanTarget(s) {
  return String(s || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueLabel(base, used) {
  let label = base;
  let i = 2;
  while (used.has(label.toLowerCase())) label = `${base} ${i++}`;
  used.add(label.toLowerCase());
  return label;
}

function routeFlowSteps(fact) {
  const used = new Set();
  const steps = [
    { type: "start", label: uniqueLabel(`${fact.method} ${fact.path}`, used) },
  ];
  if (fact.auth) steps.push({ type: "process", label: uniqueLabel("Authenticate caller", used) });
  if (fact.validation) steps.push({ type: "decision", label: uniqueLabel("Validate request", used) });
  const deps = (fact.dependencies || []).slice(0, 4).map((d) => `${humanTarget(d.target)}.${d.method}()`);
  if (deps.length) steps.push({ type: "process", label: uniqueLabel(`Call ${deps.join(", ")}`, used) });
  const sql = summarizeSqlOps(fact.sql_ops || []).slice(0, 5);
  if (sql.length) steps.push({ type: "process", label: uniqueLabel(`Postgres: ${sql.join(", ")}`, used) });
  if (fact.notifications?.length) steps.push({ type: "process", label: uniqueLabel(`Publish ${fact.notifications.join(", ")}`, used) });
  if (steps.length === 1) steps.push({ type: "process", label: uniqueLabel(`Run handler (${fact.file})`, used) });
  steps.push({ type: "end", label: uniqueLabel("HTTP response", used) });
  return steps;
}

export function flowsFromRoutes(sources, { max = 30 } = {}) {
  const muts = [];
  for (const fact of selectedRoutes(routeFactsFromSources(sources), max)) {
    const name = `${fact.method} ${fact.path}`;
    const steps = routeFlowSteps(fact);
    muts.push({ op: "add_flow", view: "flows", name });
    for (const step of steps) muts.push({ op: "add_step", view: "flows", flow: name, ...step });
    for (let i = 0; i < steps.length - 1; i++) {
      muts.push({
        op: "add_transition",
        view: "flows",
        flow: name,
        from: steps[i].label,
        to: steps[i + 1].label,
        label: steps[i].type === "decision" ? "valid" : "",
      });
    }
  }
  return muts;
}

function addParticipant(list, label) {
  if (!list.some((x) => x.toLowerCase() === label.toLowerCase())) list.push(label);
}

export function sequencesFromRoutes(sources, { max = 20 } = {}) {
  const muts = [];
  for (const fact of selectedRoutes(routeFactsFromSources(sources), max)) {
    const name = `${fact.method} ${fact.path}`;
    const participants = ["Client", "API Route"];
    if (fact.auth) addParticipant(participants, "Auth");
    const depParticipants = new Map();
    for (const d of (fact.dependencies || []).slice(0, 5)) {
      const label = humanTarget(d.target);
      depParticipants.set(d.target, label);
      addParticipant(participants, label);
    }
    if (fact.sql_ops?.length) addParticipant(participants, "Postgres");
    if (fact.notifications?.length) addParticipant(participants, "Event Bus");

    muts.push({ op: "add_sequence", view: "sequences", name });
    for (const p of participants) muts.push({ op: "add_participant", view: "sequences", seq: name, label: p });
    muts.push({ op: "add_message", view: "sequences", seq: name, from: "Client", to: "API Route", label: `${fact.method} ${fact.path}`, type: "sync" });
    if (fact.auth) {
      muts.push({ op: "add_message", view: "sequences", seq: name, from: "API Route", to: "Auth", label: "verify caller", type: "sync" });
      muts.push({ op: "add_message", view: "sequences", seq: name, from: "Auth", to: "API Route", label: "caller", type: "return" });
    }
    for (const d of (fact.dependencies || []).slice(0, 5)) {
      muts.push({ op: "add_message", view: "sequences", seq: name, from: "API Route", to: depParticipants.get(d.target), label: `${d.method}()`, type: "sync" });
    }
    const sql = summarizeSqlOps(fact.sql_ops || []).slice(0, 6);
    if (sql.length) muts.push({ op: "add_message", view: "sequences", seq: name, from: "API Route", to: "Postgres", label: sql.join(", "), type: "sync" });
    if (fact.notifications?.length) muts.push({ op: "add_message", view: "sequences", seq: name, from: "Postgres", to: "Event Bus", label: `NOTIFY ${fact.notifications.join(", ")}`, type: "async" });
    muts.push({ op: "add_message", view: "sequences", seq: name, from: "API Route", to: "Client", label: "JSON response", type: "return" });
  }
  return muts;
}
