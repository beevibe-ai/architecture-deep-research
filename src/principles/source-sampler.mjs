import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Caps so the source sample never blows the LLM context. The goal is "enough
// real code that the LLM cites real lines", not "complete representation".
const MAX_FILES_PER_TOP_LEVEL = 6;
const MAX_TOTAL_FILES = 24;
const MAX_BYTES_PER_FILE = 2_400;
const MAX_DEPTH = 4;

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
  "__pycache__",
  ".pytest_cache"
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".kt",
  ".ex",
  ".exs",
  ".php",
  ".cs",
  ".swift",
  ".scala",
  ".vue",
  ".svelte"
]);

const ENTRYPOINT_HINTS = new Set([
  "index",
  "main",
  "app",
  "server",
  "kernel",
  "router",
  "store",
  "core",
  "schema"
]);

function isSourceFile(name) {
  const ext = path.extname(name).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
}

function isLikelyTest(name) {
  return (
    /\.(test|spec)\.[mc]?[jt]sx?$/.test(name) ||
    /_test\.go$/.test(name) ||
    name.includes("__tests__")
  );
}

function entrypointRank(name) {
  const base = path.basename(name, path.extname(name)).toLowerCase();
  if (ENTRYPOINT_HINTS.has(base)) return 0;
  if (base.endsWith("-config") || base.endsWith(".config")) return 1;
  return 2;
}

async function walkSourceFiles(repoPath, dir, depth, collected) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    const childPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSourceFiles(repoPath, childPath, depth + 1, collected);
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      collected.push({
        absPath: childPath,
        relPath: path.relative(repoPath, childPath)
      });
    }
  }
}

async function safeReadFile(target, maxBytes) {
  try {
    const data = await readFile(target, "utf8");
    if (data.length <= maxBytes) return data;
    return `${data.slice(0, maxBytes)}\n// [...truncated to ${maxBytes} bytes]`;
  } catch {
    return null;
  }
}

// Pick the most-likely-load-bearing files per top-level dir. Entry-points
// first (index.*, main.*, kernel.*), then by size descending until we hit
// the per-top-level cap. Tests are skipped — they're noise for principle
// extraction since they test the rule rather than embody it.
async function pickRepresentativesForTopLevel(repoPath, topLevelName, files) {
  const filtered = files.filter((f) => !isLikelyTest(f.relPath));
  if (filtered.length === 0) return [];

  const ranked = await Promise.all(
    filtered.map(async (file) => {
      let size = 0;
      try {
        const s = await stat(file.absPath);
        size = s.size;
      } catch {
        // ignore
      }
      return {
        ...file,
        size,
        rank: entrypointRank(file.relPath)
      };
    })
  );

  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return b.size - a.size;
  });

  return ranked.slice(0, MAX_FILES_PER_TOP_LEVEL);
}

async function sampleRepoSource(repoPath) {
  // Group source files by top-level directory so each region of the repo
  // gets representation. A repo with src/, packages/, and scripts/ should
  // see all three in the sample.
  let topLevel;
  try {
    topLevel = await readdir(repoPath, { withFileTypes: true });
  } catch {
    return { samples: [], summary: { total_files: 0, top_levels: [] } };
  }

  const buckets = new Map();
  const directRootFiles = [];

  for (const entry of topLevel) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    const absPath = path.join(repoPath, entry.name);
    if (entry.isDirectory()) {
      const collected = [];
      await walkSourceFiles(repoPath, absPath, 1, collected);
      if (collected.length > 0) buckets.set(entry.name, collected);
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      directRootFiles.push({
        absPath,
        relPath: entry.name
      });
    }
  }

  if (directRootFiles.length > 0) {
    buckets.set("__root__", directRootFiles);
  }

  const picked = [];
  for (const [topLevelName, files] of buckets) {
    const reps = await pickRepresentativesForTopLevel(
      repoPath,
      topLevelName,
      files
    );
    for (const rep of reps) {
      picked.push({ ...rep, top_level: topLevelName });
      if (picked.length >= MAX_TOTAL_FILES) break;
    }
    if (picked.length >= MAX_TOTAL_FILES) break;
  }

  // Read content for each picked file. The LLM sees `path` and `content`
  // — file:line citations downstream point at these paths.
  const samples = [];
  for (const file of picked) {
    const content = await safeReadFile(file.absPath, MAX_BYTES_PER_FILE);
    if (!content) continue;
    samples.push({
      path: file.relPath,
      top_level: file.top_level === "__root__" ? null : file.top_level,
      content
    });
  }

  return {
    samples,
    summary: {
      total_files: samples.length,
      top_levels: [...buckets.keys()].filter((k) => k !== "__root__")
    }
  };
}

// Incremental sampling — used by `adr principles incremental`. Reads
// `git log --since=<sinceIso> --name-only` to find files that changed in
// the window, then reads + truncates each one as a sample. Skips files
// the source filter would normally reject (tests, lockfiles, etc.).
async function sampleChangedFilesSince(repoPath, sinceIso) {
  let stdout = "";
  try {
    const result = await execFileAsync(
      "git",
      [
        "log",
        `--since=${sinceIso}`,
        "--name-only",
        "--pretty=format:",
        "--diff-filter=AMR" // added, modified, renamed (skip pure deletes)
      ],
      { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 }
    );
    stdout = result.stdout;
  } catch {
    return { samples: [], summary: { total_files: 0, top_levels: [], since: sinceIso } };
  }

  const changedSet = new Set();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    changedSet.add(trimmed);
  }

  const samples = [];
  const topLevels = new Set();
  for (const relPath of changedSet) {
    if (!isSourceFile(relPath)) continue;
    if (isLikelyTest(relPath)) continue;
    if (samples.length >= MAX_TOTAL_FILES) break;
    const segments = relPath.split(path.sep).filter(Boolean);
    if (segments.length > 1) topLevels.add(segments[0]);
    const absPath = path.resolve(repoPath, relPath);
    const content = await safeReadFile(absPath, MAX_BYTES_PER_FILE);
    if (!content) continue; // file may have been deleted in a later commit
    samples.push({
      path: relPath,
      top_level: segments.length > 1 ? segments[0] : null,
      content
    });
  }

  return {
    samples,
    summary: {
      total_files: samples.length,
      top_levels: [...topLevels],
      since: sinceIso,
      changed_total: changedSet.size
    }
  };
}

// Full repo source walk for `adr drift`. Different from sampleRepoSource:
// drift wants every reviewable file, not a per-top-level sample. Still
// capped (drift LLM cost scales with file count), but the cap is far
// higher because drift is meant to be thorough.
const DRIFT_MAX_FILES = 200;

async function walkAllSourceFiles(repoPath, { maxFiles = DRIFT_MAX_FILES } = {}) {
  const collected = [];
  async function walk(dir, depth) {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (collected.length >= maxFiles) return;
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      const childPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(childPath, depth + 1);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        if (isLikelyTest(entry.name)) continue;
        collected.push({
          absPath: childPath,
          relPath: path.relative(repoPath, childPath)
        });
      }
    }
  }
  await walk(repoPath, 0);

  const samples = [];
  for (const file of collected) {
    const content = await safeReadFile(file.absPath, MAX_BYTES_PER_FILE);
    if (!content) continue;
    samples.push({
      path: file.relPath,
      content
    });
  }
  return samples;
}

export {
  sampleRepoSource,
  sampleChangedFilesSince,
  walkAllSourceFiles,
  DRIFT_MAX_FILES
};
