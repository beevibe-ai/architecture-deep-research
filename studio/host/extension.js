// ADR Studio — VS Code extension host.
//
// Responsibilities (kept thin on purpose):
//   - own the spec file on disk (read on open, write on every committed change)
//   - serve the built webview and bridge messages over postMessage
//   - run the design-assistant loop (Anthropic tool-calls -> IR mutations)
//
// The canonical IR + constraint + handoff logic lives in ../shared/*.mjs and is
// shared verbatim with the webview, so the two surfaces can never drift.

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

// The shared modules are ESM; the host is CJS. Node lets CJS pull ESM via
// dynamic import(). We load once and cache.
let sharedPromise = null;
function shared() {
  if (!sharedPromise) {
    sharedPromise = (async () => ({
      ir: await import("../shared/ir.mjs"),
      constraints: await import("../shared/constraints.mjs"),
      handoff: await import("../shared/handoff.mjs"),
      plan: await import("../shared/plan.mjs"),
      layout: await import("../shared/layout.mjs"),
      schema: await import("./schema.mjs"),
      catalog: await import("../shared/catalog.mjs"),
      chat: await import("./chat.mjs"),
      providers: await import("./providers.mjs"),
      drift: await import("../shared/drift.mjs"),
      buildViews: await import("./build-views.mjs"),
      repoScan: await import("./repo-scan.mjs"),
      infer: await import("./infer.mjs"),
      cluster: await import("./cluster.mjs"),
    }))();
  }
  return sharedPromise;
}

let secrets = null;

function activate(context) {
  secrets = context.secrets;
  context.subscriptions.push(
    vscode.commands.registerCommand("adrStudio.open", () => openCanvas(context)),
    vscode.commands.registerCommand("adrStudio.setApiKey", setApiKey)
  );
}

// Prompt for a provider + key and store it in VS Code SecretStorage — no JSON
// editing, no key in settings, survives restarts.
async function setApiKey() {
  const { providers } = await shared();
  const pick = await vscode.window.showQuickPick(
    providers.providerDefinitions().map((p) => ({
      label: p.label,
      id: p.id,
      description: p.id === "openai-compatible" ? "Use your own OpenAI-compatible base URL" : p.baseURL || "",
      placeHolder: p.id === "anthropic" ? "sk-ant-…" : "API key",
    })),
    { placeHolder: "Which provider's API key?" }
  );
  if (!pick) return;
  const key = await vscode.window.showInputBox({
    prompt: `${pick.label} API key (stored securely in VS Code SecretStorage)`,
    password: true,
    ignoreFocusOut: true,
    placeHolder: pick.placeHolder,
  });
  if (!key) return;
  await secrets.store(`adrStudio.${pick.id}Key`, key.trim());
  // Switch the active provider to the one we just got a key for.
  await config().update("provider", pick.id, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`${pick.label} key saved and set as the active provider. The assistant is ready.`);
}

let panel = null;

async function openCanvas(context) {
  const { ir } = await shared();

  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "adrStudio",
    "Architecture Canvas",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "dist"))],
    }
  );

  // Watch the spec file so external edits (git pull, hand-edit, another tool)
  // reflect into the canvas. Self-writes are suppressed via lastWritten.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot(), vscode.workspace.asRelativePath(specPath()))
  );
  const onExternal = async () => {
    const { ir, layout } = await shared();
    try {
      const content = fs.readFileSync(specPath(), "utf8");
      if (content === lastWritten) return; // our own write — ignore
      const { spec } = ir.migrate(JSON.parse(content));
      if (layout.repairCollapsedLayouts(spec, ["architecture"])) writeSpec(spec);
      else lastWritten = JSON.stringify(spec, null, 2);
      post({ type: "spec", spec });
      post({ type: "externalReload" });
    } catch {
      /* mid-write or invalid JSON — wait for the next event */
    }
  };
  watcher.onDidChange(onExternal);
  watcher.onDidCreate(onExternal);

  panel.onDidDispose(() => {
    watcher.dispose();
    panel = null;
  });

  panel.webview.html = renderHtml(context, panel.webview, ir);

  panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      await handleMessage(msg);
    } catch (err) {
      post({ type: "error", message: String(err && err.message ? err.message : err) });
    }
  });
}

async function handleMessage(msg) {
  const { ir, handoff, plan, schema, catalog, chat, layout, constraints, cluster } = await shared();
  switch (msg.type) {
    case "ready":
      post({ type: "spec", spec: readSpec(ir, schema, layout) });
      post({ type: "catalog", catalog: loadCatalog(catalog) });
      return;

    case "persist":
      writeSpec(msg.spec);
      post({ type: "saved" });
      return;

    case "export": {
      const built = handoff.buildHandoff(msg.spec);
      const out = handoffPath();
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(built, null, 2));
      writeSpec(msg.spec);
      post({ type: "exported", path: vscode.workspace.asRelativePath(out) });
      vscode.window.showInformationMessage(
        `Handoff written → ${vscode.workspace.asRelativePath(out)}`
      );
      return;
    }

    case "newDesign": {
      const ok = await vscode.window.showWarningMessage(
        "Clear the whole design and start fresh? This overwrites the spec file.",
        { modal: true },
        "Clear"
      );
      if (ok === "Clear") {
        const fresh = ir.emptySpec();
        writeSpec(fresh);
        post({ type: "spec", spec: fresh });
      }
      return;
    }

    case "writePlan": {
      const md = plan.generatePlan(msg.spec);
      const out = planPath();
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, md);
      writeSpec(msg.spec);
      post({ type: "planWritten", path: vscode.workspace.asRelativePath(out) });
      return;
    }

    case "writeManifests": {
      const baseDir = path.dirname(specPath());
      const out = cluster.writeGeneratedManifests(msg.spec, baseDir);
      writeSpec(msg.spec);
      post({ type: "manifestsWritten", dir: vscode.workspace.asRelativePath(out.deployDir), count: out.files.length });
      return;
    }

    case "infraValidate":
      await runInfraOp("validate", msg.spec, () => cluster.validateManifests(msg.spec, { baseDir: path.dirname(specPath()), cwd: workspaceRoot() }));
      return;

    case "infraDeploy":
      await runInfraOp("deploy", msg.spec, () => cluster.deployToMinikube(msg.spec, { baseDir: path.dirname(specPath()), cwd: workspaceRoot(), profile: msg.profile || "minikube" }), { refresh: true });
      return;

    case "infraStatus":
      await runInfraOp("status", msg.spec, () => cluster.refreshClusterStatus(msg.spec, { cwd: workspaceRoot(), profile: msg.profile || "minikube" }), { statusOnly: true });
      return;

    case "infraTeardown":
      await runInfraOp("teardown", msg.spec, () => cluster.teardownMinikube(msg.spec, { baseDir: path.dirname(specPath()), cwd: workspaceRoot(), profile: msg.profile || "minikube" }));
      return;

    case "chat":
      await runAssistantTurn(chat, catalog, constraints, msg.text, msg.spec);
      return;

    case "architectReview":
      await runArchitectReview(chat, catalog, msg.text, msg.spec);
      return;

    case "deriveLLM":
      // Use the LLM to derive a view from the architecture where there's no clean
      // structural mapping (e.g. flows). It edits via the real tools.
      await runAssistantTurn(chat, catalog, constraints, deriveInstruction(msg.view), msg.spec);
      return;

    case "generateOptions":
      await generateOptions(ir, chat, catalog, msg.spec, msg.idea || "", msg.context || "", msg.count);
      return;

    case "scanRepo":
      await scanAndDrift(msg.spec);
      return;

    default:
      return;
  }
}

function post(message) {
  if (panel) panel.webview.postMessage(message);
}

// Resolve the active provider + key + model, auto-switching to whichever provider
// actually has a key (so quota exhaustion can be handled by saving another key).
async function resolveLlm() {
  const candidates = await resolveLlmCandidates();
  return candidates[0] || { provider: config().get("provider") || "anthropic", key: null, model: "" };
}

async function resolveLlmCandidates() {
  const { providers } = await shared();
  const configured = config().get("provider") || "anthropic";
  const ids = providers.providerDefinitions().map((p) => p.id);
  const preferred = ids.includes(configured) ? configured : "anthropic";
  const ordered = [preferred, ...ids.filter((id) => id !== preferred)];
  const candidates = [];
  for (const provider of ordered) {
    const key = await apiKey(provider);
    if (!key) continue;
    const baseURL = provider === "openai-compatible" ? customBaseUrl() : undefined;
    if (provider === "openai-compatible" && !baseURL) continue;
    const modelSetting = providers.modelSetting(provider);
    const model = config().get(modelSetting) || providers.defaultModel(provider);
    candidates.push({ provider, key, model, baseURL });
  }
  return candidates;
}

function isProviderQuotaError(err) {
  const text = String(err?.message || err || "").toLowerCase();
  return /quota|insufficient_quota|rate.?limit|billing|credit|429|too many requests/.test(text);
}

async function withLlmFallback(run) {
  const { providers } = await shared();
  const candidates = await resolveLlmCandidates();
  if (!candidates.length) return run({ provider: config().get("provider") || "anthropic", key: null, model: "" });
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      if (i > 0) {
        post({ type: "chatToken", text: `\n\nSwitching to ${providers.providerLabel(candidate.provider)} because the previous provider hit a quota or rate-limit issue...\n` });
      }
      return await run(candidate);
    } catch (err) {
      lastErr = err;
      if (!isProviderQuotaError(err) || i === candidates.length - 1) throw err;
    }
  }
  throw lastErr;
}

// Run one streaming assistant turn (used by chat and by LLM-derivation).
function violationKey(v) {
  return [v.constraintId, v.view, v.nodeId || "", v.edgeId || "", v.message].join("|");
}

function addedViolations(constraints, beforeSpec, nextSpec) {
  const before = new Set(constraints.lint(beforeSpec).violations.map(violationKey));
  return constraints.lint(nextSpec).violations.filter((v) => !before.has(violationKey(v)));
}

async function runAssistantTurn(chat, catalog, constraints, userText, spec) {
  post({ type: "chatStart" });
  const result = await withLlmFallback(({ provider, key, model, baseURL }) => chat.runAssistant({
      userText, spec, provider, model, apiKey: key, baseURL,
      catalog: loadCatalog(catalog),
      onEvent: post, // streams { type: "chatToken" | "specPatch", ... } to the webview
    }));
  const newIssues = addedViolations(constraints, spec, result.spec);
  if (newIssues.length) {
    const sample = newIssues.slice(0, 3).map((v) => `- ${v.message}`).join("\n");
    post({
      type: "chatDone",
      text: `I stopped short because the direct edit would introduce ${newIssues.length} new issue${newIssues.length === 1 ? "" : "s"}:\n${sample}\n\nUse Preview for a safer option set, or revise the request with the constraint you want preserved.`,
      spec,
      trace: result.trace,
    });
    return;
  }
  writeSpec(result.spec);
  post({ type: "chatDone", text: result.text, spec: result.spec, trace: result.trace, limited: !!result.limited });
}

async function runArchitectReview(chat, catalog, userText, spec) {
  post({ type: "chatStart" });
  const result = await withLlmFallback(({ provider, key, model, baseURL }) => chat.runArchitectReview({
      userText,
      spec,
      provider,
      model,
      apiKey: key,
      baseURL,
      catalog: loadCatalog(catalog),
      onEvent: post,
    }));
  post({ type: "chatDone", text: result.text, spec, trace: [] });
}

async function runInfraOp(op, spec, fn, opts = {}) {
  post({ type: "infraOpStart", op });
  try {
    const result = await fn();
    const relDir = result.deployDir ? vscode.workspace.asRelativePath(result.deployDir) : "";
    if (opts.refresh) {
      const { cluster } = await shared();
      const status = await cluster.refreshClusterStatus(spec, {
        cwd: workspaceRoot(),
        profile: result.profile || "minikube",
        context: result.context,
        namespace: result.namespace,
      });
      post({ type: "infraStatus", op, ...status, dir: relDir, message: result.message });
      return;
    }
    if (opts.statusOnly || result.statusById) {
      post({ type: "infraStatus", op, ...result, dir: relDir });
      return;
    }
    post({ type: "infraOpDone", op, dir: relDir, namespace: result.namespace, message: result.message || `${op} complete.` });
  } catch (err) {
    post({ type: "infraOpError", op, message: String(err && err.message ? err.message : err) });
  }
}

// Generate candidate architectures from the captured requirements — each built
// in isolation (a fresh seed) so the live canvas isn't touched, optimized for a
// different angle. The human is the judge; we present rationale + tradeoffs.
const OPTION_ANGLES = [
  { id: "recommended", label: "Recommended", desc: "the smallest coherent change that best fits the current diagram and user intent" },
  { id: "pragmatic", label: "Pragmatic", desc: "the simplest design that fully meets the requirements, minimal moving parts" },
  { id: "scalable", label: "Scalable", desc: "maximum scalability and resilience, even at higher complexity/cost" },
  { id: "lean", label: "Lean / low-cost", desc: "lowest cost and operational overhead, managed services where possible" },
];

function optionAnglesFor({ idea = "", context = "", requestedCount }) {
  const text = `${idea}\n${context}`.toLowerCase();
  const wantsAlternatives = /\b(compare|alternative|option|tradeoff|variants?|choices?)\b/.test(text);
  const configured = Number(config().get("optionCount") || 0);
  const desired = Number(requestedCount || 0) || (idea && !wantsAlternatives ? 1 : configured || 3);
  const count = Math.max(1, Math.min(OPTION_ANGLES.length, desired));
  if (idea && count === 1) return OPTION_ANGLES.slice(0, 1);
  return OPTION_ANGLES.filter((a) => a.id !== "recommended").slice(0, count);
}

function requirementsText(spec) {
  const reqs = (spec.notes || []).filter((n) => n.kind === "functional" || n.kind === "non_functional");
  if (!reqs.length) return "(no explicit requirements captured — infer reasonable ones from the design title and any existing components)";
  return reqs.map((n) => `- [${n.kind}${n.priority ? "/" + n.priority : ""}] ${n.title}${n.body ? ": " + n.body : ""}`).join("\n");
}

async function generateOptions(ir, chat, catalog, baseSpec, idea = "", context = "", requestedCount = null) {
  const cleanIdea = String(idea || "").trim();
  const cleanContext = String(context || "").trim();
  const angles = optionAnglesFor({ idea: cleanIdea, context: cleanContext, requestedCount });
  post({ type: "optionsStart", count: angles.length, idea: cleanIdea });
  const candidates = await resolveLlmCandidates();
  if (!candidates.length) {
    post({ type: "optionsError", message: "The assistant needs an API key. Run “ADR Studio: Set LLM API Key” or set a provider env var." });
    return;
  }
  const reqs = requirementsText(baseSpec);
  const options = [];
  for (let i = 0; i < angles.length; i++) {
    const angle = angles[i];
    post({ type: "optionsProgress", index: i, label: angle.label });
    const seed = cleanIdea ? JSON.parse(JSON.stringify(baseSpec)) : ir.emptySpec();
    if (!cleanIdea) {
      seed.decision = { ...baseSpec.decision };
      seed.domain_model = baseSpec.domain_model;
      seed.notes = baseSpec.notes || [];
    }
    const ideaBlock = cleanIdea
      ? `User idea:\n${cleanIdea}${cleanContext ? `\n\nAdditional architecture guidance:\n${cleanContext}` : ""}`
      : "";
    const instr = cleanIdea
      ? `Current design is loaded in the canvas. ${ideaBlock}\n\nCreate a concrete changed version of the current architecture optimized for ${angle.desc}. Preserve existing components unless the idea clearly replaces them. Reuse, rename, update, or rewire matching existing components instead of pasting a generic pattern template beside the real system. Keep this as a small diff: for a short/vague idea, add at most two top-level architecture components and four edges unless the idea explicitly needs more. Prefer removals, rewiring, notes, and edge semantics over new boxes. Use apply_skill and arch_* tools only when they produce a coherent minimal change; use add_note to capture assumptions, decisions, risks, or requirements. Keep the result coherent and focused, then run auto_layout on architecture. Reply with a short rationale: one sentence for the change, then up to three bullets for tradeoffs.`
      : `Requirements:\n${reqs}\n\nDesign a system architecture optimized for ${angle.desc}. ` +
        `Build it on the architecture view using apply_skill and the arch_* tools — coherent and focused, not exhaustive. ` +
        `When done, reply with a short rationale: one sentence for the approach, then up to three bullets for concrete tradeoffs.`;
    try {
      const result = await withLlmFallback(({ provider, key, model, baseURL }) =>
        chat.runAssistant({ userText: instr, spec: seed, provider, model, apiKey: key, baseURL, catalog: loadCatalog(catalog) })
      );
      options.push({
        id: angle.id,
        label: angle.label,
        rationale: result.text,
        architecture: result.spec.views.architecture,
        notes: result.spec.notes || [],
        components: result.spec.views.architecture.nodes.filter((n) => !n.parent).map((n) => n.label),
      });
    } catch (err) {
      options.push({ id: angle.id, label: angle.label, rationale: `(generation failed: ${err.message})`, architecture: { nodes: [], edges: [] }, components: [] });
    }
  }
  post({ type: "options", options, idea: cleanIdea });
}

// Reality-binding: scan the real repo and reconstruct the system it actually
// implements. The primary output is the DIAGRAMS — the architecture inferred
// from code, plus the other views derived from it. On an empty canvas we just
// load it (the canvas IS the real system). On an existing design we diff instead,
// and offer to load the real system. Inference runs in an isolated seed.
async function scanAndDrift(designSpec) {
  const { ir, chat, catalog, drift, buildViews, repoScan, infer } = await shared();
  const repoPath = config().get("repoPath") || workspaceRoot();
  post({ type: "scanStart", repo: vscode.workspace.asRelativePath(repoPath) || repoPath });

  let scan;
  try {
    scan = await repoScan.scanRepo(repoPath);
  } catch (err) {
    post({ type: "scanError", message: `Could not scan ${repoPath}: ${err.message}` });
    return;
  }

  const seed = ir.emptySpec();
  seed.decision = { ...designSpec.decision };
  const baseline = infer.architectureFromScan(scan, seed);
  const baselineCount = topLevelCount(baseline);
  const instruction = infer.inferenceInstruction(infer.digestForInference(scan), { hasBaseline: baselineCount > 0 });
  const candidates = await resolveLlmCandidates();

  let actual;
  let scanMessage = baselineCount
    ? "Loaded a deterministic repo baseline; the assistant refined it when provider access was available."
    : "";
  if (!candidates.length) {
    if (!baselineCount) {
      post({ type: "scanError", message: "The scanner found no architecture-sized components, and no API key is configured for LLM inference. Run “ADR Studio: Set LLM API Key” or add a workspace .env key." });
      return;
    }
    actual = baseline;
    scanMessage = "No LLM provider key was available, so Scan repo loaded the deterministic repo baseline.";
  } else {
    try {
      // Stream tokens (so the user sees progress) but NOT specPatch — the inferred
      // spec is isolated and must not touch the live canvas.
      const result = await withLlmFallback(({ provider, key, model, baseURL }) =>
        chat.runAssistant({
          userText: instruction, spec: baseline, provider, model, apiKey: key,
          baseURL,
          catalog: loadCatalog(catalog),
          onEvent: (e) => { if (e.type === "chatToken") post({ type: "scanToken", text: e.text }); },
        })
      );
      actual = topLevelCount(result.spec) ? result.spec : baseline;
      if (!topLevelCount(result.spec) && baselineCount) {
        scanMessage = "The provider returned no diagram edits, so Scan repo kept the deterministic repo baseline.";
      }
    } catch (err) {
      if (!baselineCount) {
        post({ type: "scanError", message: `Inference failed: ${err.message}` });
        return;
      }
      actual = baseline;
      scanMessage = `Provider inference failed (${err.message}); Scan repo loaded the deterministic repo baseline instead.`;
    }
  }

  if (!topLevelCount(actual)) {
    post({ type: "scanError", message: "Scan repo completed, but neither the scanner nor the assistant found architecture-sized components." });
    return;
  }

  // Build the full system: real architecture + the other views reverse-engineered
  // from their REAL sources where they exist (SQL → data model, compose/k8s →
  // infra), falling back to projection-from-architecture only when no source does.
  const full = buildViews.buildAllViews(actual, scan);
  const repo = vscode.workspace.asRelativePath(repoPath) || repoPath;
  const componentCount = actual.views.architecture.nodes.filter((n) => !n.parent).length;

  const designed = designSpec.views.architecture.nodes.filter((n) => !n.parent);
  if (designed.length === 0) {
    // Empty canvas → discover: the canvas becomes the real system.
    full.decision = { ...designSpec.decision, title: designSpec.decision?.title || `${repo} — reverse-engineered` };
    writeSpec(full);
    post({ type: "spec", spec: full });
    post({ type: "scanDone", repo, count: componentCount, message: scanMessage });
    return;
  }

  // Existing design → diff, with the full inferred system available to load.
  const report = drift.diffArchitecture(designSpec.views.architecture, actual.views.architecture);
  post({ type: "driftReport", report, actual: actual.views.architecture, full, repo, count: componentCount, message: scanMessage });
}

function topLevelCount(spec) {
  return spec.views.architecture.nodes.filter((n) => !n.parent).length;
}

// Per-view instruction for LLM derivation from the architecture.
function deriveInstruction(view) {
  if (view === "flows")
    return "Derive the primary user/request flowchart(s) for this system from its architecture — show how a request moves through the components, including the key decision points. Create one or more flows with flow_create_flow and wire the steps. Only edit the flows view.";
  if (view === "sequences")
    return "Derive a sequence diagram from the architecture showing the main end-to-end interaction between components. Use seq_create. Only edit the sequences view.";
  if (view === "data_model")
    return "Enrich the data model from the architecture: for each datastore, model realistic entities with typed fields, keys, and relations. Only edit the data model view.";
  if (view === "classes")
    return "Derive a class model from the architecture's services and key components, with attributes, methods, and any inheritance. Only edit the classes view.";
  return `Refine the ${view} view based on the architecture.`;
}

// ---- spec file I/O ---------------------------------------------------------

function config() {
  return vscode.workspace.getConfiguration("adrStudio");
}

function customBaseUrl() {
  return String(config().get("openaiCompatibleBaseUrl") || "").trim();
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("Open a folder in VS Code before using the canvas.");
  }
  return folders[0].uri.fsPath;
}

function specPath() {
  return path.join(workspaceRoot(), config().get("specPath"));
}

function handoffPath() {
  return path.join(path.dirname(specPath()), "execution-handoff.json");
}

function planPath() {
  return path.join(path.dirname(specPath()), "plan.md");
}

function catalogPath() {
  return path.join(path.dirname(specPath()), "catalog.json");
}

// Built-in catalog merged with an optional project .adr/catalog.json override.
function loadCatalog(catalogMod) {
  const p = catalogPath();
  if (!fs.existsSync(p)) return catalogMod.CATALOG;
  try {
    const overrides = JSON.parse(fs.readFileSync(p, "utf8"));
    return catalogMod.mergeCatalog(Array.isArray(overrides) ? overrides : overrides.components || []);
  } catch (err) {
    vscode.window.showWarningMessage(`Ignoring catalog.json: ${err.message}`);
    return catalogMod.CATALOG;
  }
}

// Tracks the exact JSON we last wrote, so the file watcher can tell our own
// writes apart from genuine external edits (no infinite reload loop).
let lastWritten = null;

function readSpec(ir, schema, layout) {
  const p = specPath();
  if (!fs.existsSync(p)) return ir.emptySpec();
  try {
    const disk = JSON.parse(fs.readFileSync(p, "utf8"));
    // Migrate any legacy shape (0.1.0 research spec, 0.2.0 studio MVP) up to the
    // current multi-view IR. Persist the upgrade so it happens once.
    const { spec, changed, from } = ir.migrate(disk);
    const repaired = layout?.repairCollapsedLayouts(spec, ["architecture"]);
    if (changed || repaired) {
      writeSpec(spec);
      if (changed) vscode.window.showInformationMessage(`Upgraded design spec ${from} → ${spec.version}.`);
      else vscode.window.showInformationMessage("Repaired collapsed architecture layout.");
    }
    // Validate after migration — a clean signal if a hand-edited file drifts.
    const { ok, errors } = schema.validateSpec(spec);
    if (!ok) vscode.window.showWarningMessage(`Spec has schema issues: ${errors.slice(0, 3).join("; ")}`);
    lastWritten = JSON.stringify(spec, null, 2);
    return spec;
  } catch (err) {
    vscode.window.showWarningMessage(`Could not parse spec, starting fresh: ${err.message}`);
    return ir.emptySpec();
  }
}

function writeSpec(spec) {
  const p = specPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const json = JSON.stringify(spec, null, 2);
  fs.writeFileSync(p, json);
  lastWritten = json; // mark as self-write for the watcher
}

async function apiKey(provider = "anthropic") {
  // SecretStorage (set via the command) → env → ~/.adr/config.json. Falls back
  // to null so the assistant shows a clear setup hint rather than a mock reply.
  const { providers } = await shared();
  const envNames = providers.providerEnvNames(provider);
  try {
    if (secrets) {
      const stored = await secrets.get(`adrStudio.${provider}Key`);
      if (stored) return stored;
    }
  } catch {
    /* ignore */
  }
  for (const envName of envNames) if (process.env[envName]) return process.env[envName];
  const envKey = apiKeyFromWorkspaceEnv(envNames);
  if (envKey) return envKey;
  try {
    const cfg = path.join(require("os").homedir(), ".adr", "config.json");
    if (fs.existsSync(cfg)) {
      const j = JSON.parse(fs.readFileSync(cfg, "utf8"));
      for (const envName of envNames) if (j[envName]) return j[envName];
      const camel = provider.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      return j[`${camel}ApiKey`] || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function apiKeyFromWorkspaceEnv(envNames) {
  const root = workspaceRoot();
  for (const file of [".env.local", ".env"]) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    const parsed = parseEnvFile(fs.readFileSync(p, "utf8"));
    for (const envName of envNames) if (parsed[envName]) return parsed[envName];
  }
  return null;
}

function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[m[1]] = value;
  }
  return out;
}

// ---- webview html ----------------------------------------------------------

function renderHtml(context, webview, ir) {
  const distDir = path.join(context.extensionPath, "dist");
  const indexPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    return `<html><body style="font-family:sans-serif;padding:2rem">
      <h2>Canvas not built</h2>
      <p>Run <code>npm run build</code> in <code>studio/</code> first.</p>
    </body></html>`;
  }
  let html = fs.readFileSync(indexPath, "utf8");
  // Rewrite Vite's relative asset URLs (./assets/..) to webview URIs.
  html = html.replace(/(src|href)="\.\/([^"]+)"/g, (_m, attr, rel) => {
    const uri = webview.asWebviewUri(vscode.Uri.file(path.join(distDir, rel)));
    return `${attr}="${uri}"`;
  });
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
  ].join("; ");
  html = html.replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`
  );
  return html;
}

module.exports = { activate, deactivate() {} };
