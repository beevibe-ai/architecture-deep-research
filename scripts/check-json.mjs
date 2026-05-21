import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ignoredDirs = new Set([".git", "node_modules"]);

async function collectJsonFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;

    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonFiles(entryPath)));
      continue;
    }

    if (entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }

  return files;
}

const files = await collectJsonFiles(".");

for (const file of files.sort()) {
  JSON.parse(await readFile(file, "utf8"));
  console.log(`valid json: ${file}`);
}
