// Vendored verbatim from ../../src/discover/repo-scan.mjs so the packaged .vsix
// is self-contained (the extension ships only files under studio/). It produces
// a structured repo digest — manifests, deploy configs, tree, observability
// signals — that the architecture inference reads to discover the REAL system.
// Keep in sync with the source if the scanner gains signals worth inferring on.
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Caps to keep LLM payloads tractable. The scan is meant to be a digest,
// not a complete repo dump.
const MAX_DOC_BYTES = 8_000;
const MAX_MANIFEST_BYTES = 6_000;
const MAX_TODO_HITS = 40;
const MAX_DOC_FILES = 12;
const MAX_DIR_DEPTH = 5;
const MAX_DIR_ENTRIES_PER_LEVEL = 30;
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".adr-runs",
  ".smoke-runs",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "coverage",
  "vendor",
  "target",
  ".venv",
  "venv",
  "__pycache__"
]);

const MANIFEST_FILES = new Map([
  ["package.json", "node"],
  ["package-lock.json", "node-lock"],
  ["pnpm-lock.yaml", "node-lock"],
  ["yarn.lock", "node-lock"],
  ["go.mod", "go"],
  ["go.sum", "go-lock"],
  ["Cargo.toml", "rust"],
  ["Cargo.lock", "rust-lock"],
  ["requirements.txt", "python"],
  ["pyproject.toml", "python"],
  ["Pipfile", "python"],
  ["poetry.lock", "python-lock"],
  ["Gemfile", "ruby"],
  ["Gemfile.lock", "ruby-lock"],
  ["pom.xml", "java"],
  ["build.gradle", "java"],
  ["build.gradle.kts", "java"],
  ["composer.json", "php"],
  ["mix.exs", "elixir"]
]);

const DEPLOY_CONFIG_FILES = new Map([
  ["Dockerfile", "docker"],
  ["docker-compose.yml", "docker-compose"],
  ["docker-compose.yaml", "docker-compose"],
  ["fly.toml", "fly.io"],
  ["vercel.json", "vercel"],
  ["railway.json", "railway"],
  ["railway.toml", "railway"],
  ["render.yaml", "render"],
  ["app.yaml", "google-app-engine"],
  ["serverless.yml", "serverless-framework"],
  ["netlify.toml", "netlify"],
  ["Procfile", "heroku-style"],
  ["wrangler.toml", "cloudflare-workers"]
]);

const DEPLOY_CONFIG_DIRS = new Set([
  "kubernetes",
  "k8s",
  ".github/workflows",
  ".gitlab-ci",
  "helm",
  "charts",
  "terraform",
  "ansible"
]);

const DOC_FILE_NAMES = [
  "README.md",
  "ARCHITECTURE.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "DESIGN.md",
  "DECISIONS.md",
  // Agent + team-philosophy docs — high-signal for product-intent
  // extraction (the team often encodes "how we work" here, not in code).
  "CLAUDE.md",
  "AGENTS.md",
  "PHILOSOPHY.md",
  "PRINCIPLES.md"
];

const DOC_DIRS = ["docs/adr", "docs/architecture", "docs/decisions", "adr", "decisions"];

const TODO_PATTERN = /\b(TODO|FIXME|XXX|HACK|DEPRECATED)\b[:\s]?([^\n]*)/g;
const OBS_LIB_PATTERNS = [
  { regex: /from\s+opentelemetry/i, name: "opentelemetry" },
  { regex: /import\s+\*?\s*as?\s*Sentry|@sentry\//, name: "sentry" },
  { regex: /\bdatadog-api-client\b|\bdd-trace\b|@datadog\//, name: "datadog" },
  { regex: /prom-client|prometheus_client/, name: "prometheus" },
  { regex: /pino|winston|bunyan|@logtail/, name: "structured-logging-node" },
  { regex: /\bstructlog\b|\bloguru\b/, name: "structured-logging-python" }
];

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function safeReadFile(target, { maxBytes = MAX_DOC_BYTES } = {}) {
  try {
    const data = await readFile(target, "utf8");
    if (data.length <= maxBytes) return data;
    return `${data.slice(0, maxBytes)}\n[...truncated to ${maxBytes} bytes]`;
  } catch {
    return null;
  }
}

function relativeTo(repoPath, target) {
  return path.relative(repoPath, target) || ".";
}

async function listTopLevel(repoPath) {
  const entries = await readdir(repoPath, { withFileTypes: true });
  return entries
    .filter((entry) => !IGNORED_DIRS.has(entry.name))
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "dir" : "file"
    }));
}

async function listShallowTree(repoPath) {
  const result = [];
  async function walk(currentPath, depth) {
    if (depth > MAX_DIR_DEPTH) return;
    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    const filtered = entries
      .filter((entry) => !IGNORED_DIRS.has(entry.name))
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_DIR_ENTRIES_PER_LEVEL);
    for (const entry of filtered) {
      const childPath = path.join(currentPath, entry.name);
      const rel = relativeTo(repoPath, childPath);
      if (entry.isDirectory()) {
        result.push({ path: rel, kind: "dir" });
        if (depth < MAX_DIR_DEPTH) {
          await walk(childPath, depth + 1);
        }
      }
    }
  }
  await walk(repoPath, 0);
  return result;
}

async function collectDocs(repoPath) {
  const docs = [];
  for (const name of DOC_FILE_NAMES) {
    const target = path.join(repoPath, name);
    if (!(await pathExists(target))) continue;
    const content = await safeReadFile(target);
    if (content) {
      docs.push({ path: relativeTo(repoPath, target), content });
    }
  }
  for (const dir of DOC_DIRS) {
    const target = path.join(repoPath, dir);
    if (!(await pathExists(target))) continue;
    let entries;
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch {
      continue;
    }
    const mdEntries = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_DOC_FILES);
    for (const entry of mdEntries) {
      const docPath = path.join(target, entry.name);
      const content = await safeReadFile(docPath);
      if (content) {
        docs.push({ path: relativeTo(repoPath, docPath), content, kind: "prior_adr" });
      }
    }
  }
  return docs.slice(0, MAX_DOC_FILES);
}

async function collectManifests(repoPath) {
  const manifests = [];
  for (const [name, kind] of MANIFEST_FILES) {
    const target = path.join(repoPath, name);
    if (!(await pathExists(target))) continue;
    const isLock = kind.endsWith("-lock");
    const content = await safeReadFile(target, {
      maxBytes: isLock ? 1_000 : MAX_MANIFEST_BYTES
    });
    if (content) {
      manifests.push({
        path: relativeTo(repoPath, target),
        kind,
        // Lockfiles are huge and not informative for principle extraction; we
        // only note their presence as a signal.
        content: isLock ? "[lockfile present]" : content
      });
    }
  }
  return manifests;
}

async function collectDeployConfigs(repoPath) {
  const configs = [];
  for (const [name, platform] of DEPLOY_CONFIG_FILES) {
    const target = path.join(repoPath, name);
    if (!(await pathExists(target))) continue;
    const content = await safeReadFile(target, { maxBytes: 12_000 });
    configs.push({
      path: relativeTo(repoPath, target),
      platform,
      content: content || ""
    });
  }
  for (const dir of DEPLOY_CONFIG_DIRS) {
    const target = path.join(repoPath, dir);
    if (await pathExists(target)) {
      configs.push({ path: dir, platform: dir, content: "[directory present]" });
    }
  }
  return configs;
}

async function collectCodeowners(repoPath) {
  for (const candidate of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]) {
    const target = path.join(repoPath, candidate);
    if (!(await pathExists(target))) continue;
    const content = await safeReadFile(target, { maxBytes: 4_000 });
    if (content) {
      return { path: relativeTo(repoPath, target), content };
    }
  }
  return null;
}

async function gitLog(repoPath, args, maxBytes = 4_000) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
      maxBuffer: 8 * 1024 * 1024
    });
    if (stdout.length <= maxBytes) return stdout;
    return `${stdout.slice(0, maxBytes)}\n[...truncated]`;
  } catch {
    return null;
  }
}

async function collectGitSignals(repoPath) {
  const isRepo = await pathExists(path.join(repoPath, ".git"));
  if (!isRepo) return null;

  const headSha = await gitLog(repoPath, ["rev-parse", "HEAD"], 80);
  const branch = await gitLog(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], 80);
  const firstCommitDate = await gitLog(
    repoPath,
    ["log", "--reverse", "--format=%aI", "--max-count=1"],
    80
  );
  const lastCommitDate = await gitLog(
    repoPath,
    ["log", "-1", "--format=%aI"],
    80
  );
  const contributorCount = await gitLog(
    repoPath,
    ["shortlog", "-sn", "--no-merges", "HEAD"],
    1_200
  );

  // Look for removed-dependency signal in package.json history. The pattern is
  // a line starting with "-" in git log -p output that names a dep block. This
  // is a coarse signal but useful as an anti-pattern hint.
  const removedDeps = await gitLog(
    repoPath,
    ["log", "-p", "--no-color", "-S", "\"dependencies\"", "--", "package.json"],
    3_000
  );

  return {
    head: (headSha || "").trim() || null,
    branch: (branch || "").trim() || null,
    first_commit_at: (firstCommitDate || "").trim() || null,
    last_commit_at: (lastCommitDate || "").trim() || null,
    contributors_shortlog: contributorCount,
    package_json_history_excerpt: removedDeps
  };
}

async function collectTodoHits(repoPath) {
  // Use git grep when available — it respects .gitignore and is much faster
  // than walking the tree ourselves.
  if (!(await pathExists(path.join(repoPath, ".git")))) {
    return [];
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        repoPath,
        "grep",
        "-n",
        "-I",
        "--",
        "-e",
        "TODO",
        "-e",
        "FIXME",
        "-e",
        "XXX",
        "-e",
        "HACK"
      ],
      { maxBuffer: 4 * 1024 * 1024 }
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, MAX_TODO_HITS)
      .map((line) => {
        // git grep format: path:line:content
        const [file, lineNo, ...rest] = line.split(":");
        return {
          file,
          line: Number(lineNo) || null,
          text: rest.join(":").trim().slice(0, 240)
        };
      });
  } catch {
    return [];
  }
}

function detectObservability(manifests, docs) {
  const sources = [];
  for (const m of manifests) {
    for (const obs of OBS_LIB_PATTERNS) {
      if (obs.regex.test(m.content)) {
        sources.push({ name: obs.name, evidence_cite: [m.path] });
      }
    }
  }
  for (const d of docs) {
    for (const obs of OBS_LIB_PATTERNS) {
      if (obs.regex.test(d.content)) {
        sources.push({ name: obs.name, evidence_cite: [d.path] });
      }
    }
  }
  // dedupe by name
  const byName = new Map();
  for (const item of sources) {
    if (byName.has(item.name)) {
      byName.get(item.name).evidence_cite.push(...item.evidence_cite);
    } else {
      byName.set(item.name, { name: item.name, evidence_cite: [...item.evidence_cite] });
    }
  }
  return [...byName.values()];
}

// Collect the real schema sources the data model is reverse-engineered from:
// SQL migrations / DDL and ORM schema files (Prisma, etc.). These are parsed
// deterministically (not sent to an LLM), so we can take more of them.
const MAX_SCHEMA_FILES = 120;
const MAX_SCHEMA_BYTES = 40_000;
const SCHEMA_FILE_RE = /(^|\/)(migrations?|db|database|sql|prisma|schema)\/.*\.(sql|prisma)$|(^|\/)schema\.(sql|prisma)$|\.(sql|prisma)$/i;
async function collectSchemaSources(repoPath) {
  let files = [];
  if (await pathExists(path.join(repoPath, ".git"))) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", repoPath, "ls-files", "*.sql", "*.prisma"], { maxBuffer: 4 * 1024 * 1024 });
      files = stdout.split("\n").filter(Boolean);
    } catch { /* fall through */ }
  }
  files = files.filter((f) => SCHEMA_FILE_RE.test(f)).sort().slice(0, MAX_SCHEMA_FILES);
  const out = [];
  for (const rel of files) {
    const content = await safeReadFile(path.join(repoPath, rel), { maxBytes: MAX_SCHEMA_BYTES });
    if (content) out.push({ path: rel, content });
  }
  return out;
}

async function scanRepo(repoPath) {
  const absRepo = path.resolve(repoPath);
  const exists = await pathExists(absRepo);
  if (!exists) {
    throw new Error(`scanRepo: repo path not found: ${absRepo}`);
  }

  const topLevel = await listTopLevel(absRepo);
  const tree = await listShallowTree(absRepo);
  const docs = await collectDocs(absRepo);
  const manifests = await collectManifests(absRepo);
  const deployConfigs = await collectDeployConfigs(absRepo);
  const codeowners = await collectCodeowners(absRepo);
  const gitSignals = await collectGitSignals(absRepo);
  const todos = await collectTodoHits(absRepo);
  const observability = detectObservability(manifests, docs);
  const schemaSources = await collectSchemaSources(absRepo);

  return {
    repo_path: absRepo,
    top_level: topLevel,
    tree,
    docs,
    manifests,
    deploy_configs: deployConfigs,
    schema_sources: schemaSources,
    codeowners,
    git_signals: gitSignals,
    todo_hits: todos,
    observability_signals: observability,
    summary: {
      file_count: tree.length,
      doc_count: docs.length,
      manifest_count: manifests.length,
      deploy_config_count: deployConfigs.length,
      schema_source_count: schemaSources.length,
      todo_hit_count: todos.length,
      prior_adr_count: docs.filter((d) => d.kind === "prior_adr").length
    }
  };
}

export { scanRepo };
