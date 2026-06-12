#!/usr/bin/env node
// Headless debug driver for the scan/derive/inference pipeline. Lets us drive the
// tool from the terminal — no VS Code, no clicking — and inspect exactly what it
// produces: per-view counts, lint violations, and layout health (nodes stacked at
// the origin, the #1 "ugly diagram" symptom). This is how we debug ourselves.
//
// Usage:
//   node studio/host/debug-scan.mjs scan   <repoPath>      # repo digest only (no LLM)
//   node studio/host/debug-scan.mjs derive <specPath>      # re-derive all views from a spec, report (no LLM)
//   node studio/host/debug-scan.mjs report <specPath>      # lint + layout report on a spec as-is (no LLM)
//   node studio/host/debug-scan.mjs infer  <repoPath>      # full inference (needs an API key in ~/.adr/config.json)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptySpec, applyMutation } from "../shared/ir.mjs";
import { lint } from "../shared/constraints.mjs";
import { DERIVABLE_VIEWS } from "../shared/derive.mjs";
import { scanRepo } from "./repo-scan.mjs";
import { buildAllViews } from "./build-views.mjs";
import { digestForInference, inferenceInstruction } from "./infer.mjs";
import { routeFactsFromSources } from "./extract.mjs";

const [cmd, target] = process.argv.slice(2);
if (!cmd || !target) {
  console.error("usage: debug-scan.mjs <scan|derive|report|infer> <path>");
  process.exit(1);
}

function loadSpec(p) {
  return JSON.parse(fs.readFileSync(path.resolve(p), "utf8"));
}

// The core inspector: counts, lint, and layout health per view.
function report(spec, title) {
  console.log(`\n=== ${title} ===`);
  const v = spec.views;
  console.log(
    `arch=${v.architecture.nodes.length}/${v.architecture.edges.length}e  ` +
    `infra=${v.infra.nodes.length}/${v.infra.edges.length}e  ` +
    `data_model=${v.data_model.entities.length}  flows=${v.flows.length}  classes=${v.classes.nodes.length}  ` +
    `sequences=${v.sequences.length}  cross_refs=${(spec.cross_refs || []).length}`
  );

  const { violations } = lint(spec);
  console.log(`lint: ${violations.length} violation(s)`);
  const byRule = {};
  for (const vi of violations) byRule[vi.constraintId || vi.rule] = (byRule[vi.constraintId || vi.rule] || 0) + 1;
  for (const [rule, n] of Object.entries(byRule)) console.log(`  ${n}× ${rule}`);

  // Layout health: non-root nodes sharing position (0,0) overlap into an unreadable pile.
  const layoutProblems = [];
  for (const [view, nodes] of [["architecture", v.architecture.nodes], ["infra", v.infra.nodes]]) {
    const atOrigin = nodes.filter((n) => (n.position?.x ?? 0) === 0 && (n.position?.y ?? 0) === 0);
    if (atOrigin.length > 1) layoutProblems.push(`${view}: ${atOrigin.length} nodes stacked at (0,0) → ${atOrigin.map((n) => n.label).join(", ")}`);
  }
  console.log(layoutProblems.length ? "layout: ✗\n  " + layoutProblems.join("\n  ") : "layout: ✓ (no origin pile-ups)");
  return { violations: violations.length, layoutProblems: layoutProblems.length };
}

function deriveAll(spec) {
  let s = spec;
  for (const view of DERIVABLE_VIEWS) {
    try { s = applyMutation(s, { op: "derive", view }); } catch (e) { console.error(`derive ${view} failed: ${e.message}`); }
  }
  return s;
}

// Load the LLM key the same way the extension host does.
function apiKeyFromConfig() {
  if (process.env.ADR_OPENAI_API_KEY) return { provider: "openai", key: process.env.ADR_OPENAI_API_KEY };
  if (process.env.OPENAI_API_KEY) return { provider: "openai", key: process.env.OPENAI_API_KEY };
  if (process.env.ANTHROPIC_API_KEY) return { provider: "anthropic", key: process.env.ANTHROPIC_API_KEY };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".adr", "config.json"), "utf8"));
    if (j.ADR_OPENAI_API_KEY || j.OPENAI_API_KEY) return { provider: "openai", key: j.ADR_OPENAI_API_KEY || j.OPENAI_API_KEY };
    if (j.ANTHROPIC_API_KEY) return { provider: "anthropic", key: j.ANTHROPIC_API_KEY };
  } catch { /* none */ }
  return null;
}

async function main() {
  if (cmd === "scan") {
    const scan = await scanRepo(target);
    console.log("repo:", scan.repo_path);
    console.log("summary:", JSON.stringify(scan.summary));
    console.log("manifests:", scan.manifests.map((m) => m.path).join(", "));
    console.log("deploy_configs:", scan.deploy_configs.map((c) => `${c.path}(${c.platform})`).join(", "));
    const routes = routeFactsFromSources(scan.route_sources || []);
    console.log("route_sources:", (scan.route_sources || []).map((r) => r.path).join(", "));
    console.log("routes:", routes.slice(0, 24).map((r) => `${r.method} ${r.path}`).join(", "));
    console.log("dirs:", scan.tree.filter((t) => t.kind === "dir").map((t) => t.path).slice(0, 40).join(", "));
    console.log("\n--- digest fed to inference ---\n" + digestForInference(scan).slice(0, 2000));
    return;
  }
  if (cmd === "report") {
    report(loadSpec(target), `report: ${target}`);
    return;
  }
  if (cmd === "derive") {
    const spec = loadSpec(target);
    report(spec, "before re-derive");
    report(deriveAll(spec), "after re-derive (all views)");
    return;
  }
  if (cmd === "infer") {
    const auth = apiKeyFromConfig();
    if (!auth) { console.error("no API key (set ADR_OPENAI_API_KEY or ~/.adr/config.json)"); process.exit(1); }
    const { runAssistant } = await import("./chat.mjs");
    const { CATALOG } = await import("../shared/catalog.mjs");
    const scan = await scanRepo(target);
    console.log(`scanned ${scan.summary.file_count} files; inferring with ${auth.provider}…`);
    const seed = emptySpec();
    const result = await runAssistant({
      userText: inferenceInstruction(digestForInference(scan)),
      spec: seed, provider: auth.provider, apiKey: auth.key, catalog: CATALOG,
    });
    const full = buildAllViews(result.spec, scan); // real extraction per view
    report(full, `inferred: ${target}`);
    const dm = full.views.data_model;
    console.log(`data model: ${dm.entities.length} entities, ${dm.relations.length} relations → ${dm.entities.slice(0, 12).map((e) => e.name).join(", ")}${dm.entities.length > 12 ? "…" : ""}`);
    console.log(`infra: ${full.views.infra.nodes.map((n) => `${n.label}(${n.type})`).join(", ")}`);
    console.log(`flows: ${full.views.flows.slice(0, 8).map((f) => `${f.name}(${f.nodes.length})`).join(", ")}${full.views.flows.length > 8 ? "…" : ""}`);
    console.log(`sequences: ${full.views.sequences.slice(0, 8).map((s) => `${s.name}(${s.messages.length})`).join(", ")}${full.views.sequences.length > 8 ? "…" : ""}`);
    const out = path.join(target, ".adr", "debug-scan.spec.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(full, null, 2));
    console.log(`\nwrote ${out}`);
    console.log("assistant said:", result.text);
    return;
  }
  console.error(`unknown command ${cmd}`);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
