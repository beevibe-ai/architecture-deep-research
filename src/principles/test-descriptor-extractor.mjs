// Test descriptor extractor. Test names are the team's executable
// specification — `it("must not allow duplicate selections")` is a
// principle stated in code that gets enforced by CI. We mine these to
// feed product-intent + per-lens extraction.
//
// Walks the repo looking for test files, parses describe/it/test
// strings, returns up to MAX_DESCRIPTORS. No LLM call.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_DESCRIPTORS = 60;
const MAX_FILES_SCANNED = 80;
const MAX_DEPTH = 5;
const MAX_BYTES_PER_FILE = 50_000;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "vendor",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".adr-runs",
  ".smoke-runs"
]);

function isTestFile(name) {
  return (
    /\.(test|spec)\.(m|c)?[jt]sx?$/.test(name) ||
    /_test\.go$/.test(name) ||
    /^test_.*\.py$/.test(name) ||
    /_test\.py$/.test(name) ||
    /_spec\.rb$/.test(name)
  );
}

// Match describe / it / test / suite / context with a string literal.
// Tolerates single + double + template quotes, async/arrow wrappers.
const DESCRIBE_PATTERN =
  /\b(describe|it|test|suite|context|t\.Run|TestCase)\s*\(\s*(?:`|"|')([^`"']{4,200})(?:`|"|')/g;

async function walkTests(dir, depth, repoPath, files) {
  if (depth > MAX_DEPTH) return;
  if (files.length >= MAX_FILES_SCANNED) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= MAX_FILES_SCANNED) return;
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkTests(child, depth + 1, repoPath, files);
    } else if (entry.isFile() && isTestFile(entry.name)) {
      files.push({ absPath: child, relPath: path.relative(repoPath, child) });
    }
  }
}

async function readClipped(p) {
  try {
    const buf = await readFile(p, "utf8");
    return buf.length > MAX_BYTES_PER_FILE
      ? buf.slice(0, MAX_BYTES_PER_FILE)
      : buf;
  } catch {
    return null;
  }
}

async function extractTestDescriptors(repoPath) {
  const files = [];
  await walkTests(repoPath, 0, repoPath, files);
  const descriptors = [];
  for (const f of files) {
    if (descriptors.length >= MAX_DESCRIPTORS) break;
    const text = await readClipped(f.absPath);
    if (!text) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (descriptors.length >= MAX_DESCRIPTORS) break;
      const line = lines[i];
      DESCRIBE_PATTERN.lastIndex = 0;
      let m;
      while ((m = DESCRIBE_PATTERN.exec(line))) {
        descriptors.push({
          file: f.relPath,
          line: i + 1,
          kind: m[1],
          text: m[2].trim()
        });
        if (descriptors.length >= MAX_DESCRIPTORS) break;
      }
    }
  }
  return {
    descriptors,
    summary: {
      file_count: files.length,
      descriptor_count: descriptors.length
    }
  };
}

export { extractTestDescriptors, isTestFile };
