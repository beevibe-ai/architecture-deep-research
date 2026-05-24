#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const ignoredDirs = new Set([".adr-runs", ".smoke-runs", ".git", "node_modules", "dist"]);

const schemaByFilename = {
  "architecture.spec.json": "docs/schemas/architecture-spec.schema.json",
  "claim-audit.json": "docs/schemas/claim-audit.schema.json",
  "citation-audit.json": "docs/schemas/citation-audit.schema.json",
  "clarification.json": "docs/schemas/clarification.schema.json",
  "decision-context.json": "docs/schemas/decision-context.schema.json",
  "comparison-matrix.json": "docs/schemas/comparison-matrix.schema.json",
  "critique.json": "docs/schemas/critique.schema.json",
  "discovered-constraints.json": "docs/schemas/discovered-constraints.schema.json",
  "discovered-principles.json": "docs/schemas/discovered-principles.schema.json",
  "domain-evaluation-pack.json": "docs/schemas/domain-evaluation-pack.schema.json",
  "evidence.json": "docs/schemas/evidence.schema.json",
  "execution-handoff.json": "docs/schemas/execution-handoff.schema.json",
  "follow-up-questions.json": "docs/schemas/follow-up-questions.schema.json",
  "knowledge-map.json": "docs/schemas/knowledge-map.schema.json",
  "peers.json": "docs/schemas/peers.schema.json",
  "research-plan.json": "docs/schemas/research-plan.schema.json",
  "strategic-context.json": "docs/schemas/strategic-context.schema.json",
  "supersedes.json": "docs/schemas/supersedes.schema.json"
};

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

async function loadSchemas() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validators = new Map();

  for (const [filename, schemaPath] of Object.entries(schemaByFilename)) {
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    validators.set(filename, ajv.compile(schema));
  }

  return validators;
}

const validators = await loadSchemas();
const files = await collectJsonFiles(".");

for (const file of files.sort()) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  const validator = validators.get(path.basename(file));
  if (validator && !validator(parsed)) {
    const errors = ajvErrors(validator.errors);
    throw new Error(`schema invalid: ${file}\n${errors}`);
  }
  console.log(validator ? `valid schema: ${file}` : `valid json: ${file}`);
}

function ajvErrors(errors = []) {
  return errors
    .map((error) => {
      const location = error.instancePath || "/";
      return `- ${location} ${error.message}`;
    })
    .join("\n");
}
