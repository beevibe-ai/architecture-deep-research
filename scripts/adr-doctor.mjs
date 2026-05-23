#!/usr/bin/env node
// adr-doctor — environment audit + first-run setup for ADR.
//
// Two modes:
//   adr-doctor          audit-only: reports what is configured and what is
//                       missing. Non-interactive. Exit 0 if ready, 1 if not.
//   adr-doctor setup    interactive: prompts the user for the missing keys,
//                       writes them to ~/.adr/config.json, prints the export
//                       lines they can add to their shell rc file.
//
// The MCP server reads ~/.adr/config.json on startup and falls back to env
// vars. So a user who runs `adr-doctor setup` once never has to remember
// to export anything in the shell that launches Claude Code.

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const CONFIG_DIR = path.join(os.homedir(), ".adr");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const SEARCH_PROVIDERS = [
  { key: "BRAVE_SEARCH_API_KEY", label: "Brave Search", url: "https://api-dashboard.search.brave.com" },
  { key: "TAVILY_API_KEY",       label: "Tavily",       url: "https://tavily.com" },
  { key: "SERPER_API_KEY",       label: "Serper",       url: "https://serper.dev" },
  { key: "SEARXNG_URL",          label: "SearXNG",      url: "https://docs.searxng.org (self-hosted)" }
];

const LLM_PROVIDERS = [
  { key: "ADR_OPENAI_API_KEY", label: "OpenAI (preferred name)", url: "https://platform.openai.com/api-keys" },
  { key: "OPENAI_API_KEY",     label: "OpenAI (fallback name)",  url: "https://platform.openai.com/api-keys" }
];

const OPTIONAL = [
  { key: "GITHUB_TOKEN", label: "GitHub token", url: "https://github.com/settings/tokens", note: "Lifts the GitHub API rate limit from 60/hr to 5000/hr — strongly recommended for multi-repo research runs." },
  { key: "ADR_MODEL",    label: "Model override", url: "(any OpenAI-compatible model id)", note: "Defaults to gpt-4.1-mini. Set to override." }
];

async function loadConfigFile() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function readKey(key, config) {
  // Process env wins over config-file, matching the conventional Unix
  // override semantics. Empty string is treated as "not set".
  if (process.env[key] && process.env[key].trim()) return { value: process.env[key], source: "env" };
  if (config[key] && String(config[key]).trim()) return { value: String(config[key]), source: "config" };
  return { value: null, source: null };
}

function maskedValue(value) {
  if (!value) return null;
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

async function audit() {
  const config = await loadConfigFile();

  const searchHits = SEARCH_PROVIDERS.map((p) => ({ ...p, ...readKey(p.key, config) }));
  const llmHits = LLM_PROVIDERS.map((p) => ({ ...p, ...readKey(p.key, config) }));
  const optionalHits = OPTIONAL.map((p) => ({ ...p, ...readKey(p.key, config) }));

  const searchOk = searchHits.some((p) => p.value);
  const llmOk = llmHits.some((p) => p.value);

  const lines = [];
  lines.push("Architecture Deep Research — environment audit");
  lines.push("");
  lines.push(`Config file: ${CONFIG_PATH}`);
  let configExists = false;
  try {
    await stat(CONFIG_PATH);
    configExists = true;
  } catch {}
  lines.push(`             ${configExists ? "exists" : "not created (run `adr-doctor setup`)"}`);
  lines.push("");

  lines.push("Search provider (at least one required):");
  for (const p of searchHits) {
    const status = p.value ? `✓ ${p.source}` : "—";
    lines.push(`  [${status}]  ${p.key.padEnd(22)} ${p.value ? maskedValue(p.value) : ""}`);
  }
  lines.push("");
  lines.push("LLM provider (at least one required):");
  for (const p of llmHits) {
    const status = p.value ? `✓ ${p.source}` : "—";
    lines.push(`  [${status}]  ${p.key.padEnd(22)} ${p.value ? maskedValue(p.value) : ""}`);
  }
  lines.push("");
  lines.push("Optional:");
  for (const p of optionalHits) {
    const status = p.value ? `✓ ${p.source}` : "—";
    lines.push(`  [${status}]  ${p.key.padEnd(22)} ${p.value ? maskedValue(p.value) : ""}`);
  }
  lines.push("");
  if (searchOk && llmOk) {
    lines.push("READY. Run `adr deep-research --discover-first --repo . --domain X --decision Y --out .adr-runs/Y`");
  } else {
    lines.push("NOT READY. Run `adr-doctor setup` to configure the missing keys.");
  }
  return { ready: searchOk && llmOk, output: lines.join("\n") };
}

async function promptOne(rl, key, label, url, hint) {
  console.log(`\n${label}  (${key})`);
  console.log(`  ${url}`);
  if (hint) console.log(`  ${hint}`);
  const value = (await rl.question("  Paste value (leave blank to skip): ")).trim();
  return value || null;
}

async function setup() {
  const config = await loadConfigFile();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("ADR setup. Paste the keys you have; skip the rest.");
  console.log(`Writing to: ${CONFIG_PATH}`);
  console.log("(Process env vars always take priority over this file at runtime.)\n");

  try {
    console.log("==> Search provider — pick at least one.");
    for (const p of SEARCH_PROVIDERS) {
      const existing = config[p.key];
      if (existing) {
        const keep = (await rl.question(`${p.key} is already set (${maskedValue(existing)}). Keep? [Y/n]: `)).trim().toLowerCase();
        if (keep === "" || keep === "y" || keep === "yes") continue;
      }
      const value = await promptOne(rl, p.key, p.label, p.url);
      if (value) config[p.key] = value;
      else delete config[p.key];
    }

    console.log("\n==> LLM provider — pick at least one.");
    for (const p of LLM_PROVIDERS) {
      const existing = config[p.key];
      if (existing) {
        const keep = (await rl.question(`${p.key} is already set (${maskedValue(existing)}). Keep? [Y/n]: `)).trim().toLowerCase();
        if (keep === "" || keep === "y" || keep === "yes") continue;
      }
      const value = await promptOne(rl, p.key, p.label, p.url);
      if (value) config[p.key] = value;
      else delete config[p.key];
    }

    console.log("\n==> Optional (recommended).");
    for (const p of OPTIONAL) {
      const existing = config[p.key];
      if (existing) {
        const keep = (await rl.question(`${p.key} is already set (${maskedValue(existing)}). Keep? [Y/n]: `)).trim().toLowerCase();
        if (keep === "" || keep === "y" || keep === "yes") continue;
      }
      const value = await promptOne(rl, p.key, p.label, p.url, p.note);
      if (value) config[p.key] = value;
      else delete config[p.key];
    }
  } finally {
    rl.close();
  }

  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(`\nWrote ${CONFIG_PATH}`);

  // Final audit so the user sees the new state immediately.
  const { ready, output } = await audit();
  console.log("\n" + output);
  if (!ready) {
    process.exitCode = 1;
  }
}

// Helper exported for the MCP server: hydrates process.env from ~/.adr/config.json
// so child kernel calls see the keys without the user exporting anything.
async function loadConfigIntoEnv() {
  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    return { loaded: 0, path: CONFIG_PATH };
  }
  let count = 0;
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string" && value.trim() && !process.env[key]) {
      process.env[key] = value;
      count += 1;
    }
  }
  return { loaded: count, path: CONFIG_PATH };
}

export { loadConfigIntoEnv, audit, CONFIG_PATH };

// CLI detection that works for both direct invocation (`node adr-doctor.mjs`)
// and global-bin invocation (npm symlinks `adr-doctor` to this file via the
// package's "bin" entry).
function isCliInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isCliInvocation()) {
  const mode = process.argv[2] || "audit";
  if (mode === "setup") {
    await setup();
  } else {
    const { ready, output } = await audit();
    console.log(output);
    process.exitCode = ready ? 0 : 1;
  }
}
