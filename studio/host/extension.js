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
      schema: await import("./schema.mjs"),
      catalog: await import("../shared/catalog.mjs"),
      chat: await import("./chat.mjs"),
      drift: await import("../shared/drift.mjs"),
      buildViews: await import("./build-views.mjs"),
      repoScan: await import("./repo-scan.mjs"),
      infer: await import("./infer.mjs"),
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
  const pick = await vscode.window.showQuickPick(
    [
      { label: "Anthropic", id: "anthropic", placeHolder: "sk-ant-…" },
      { label: "OpenAI", id: "openai", placeHolder: "sk-…" },
    ],
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
    const { ir } = await shared();
    try {
      const content = fs.readFileSync(specPath(), "utf8");
      if (content === lastWritten) return; // our own write — ignore
      const { spec } = ir.migrate(JSON.parse(content));
      lastWritten = JSON.stringify(spec, null, 2);
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
  const { ir, handoff, plan, schema, catalog, chat } = await shared();
  switch (msg.type) {
    case "ready":
      post({ type: "spec", spec: readSpec(ir, schema) });
      post({ type: "catalog", catalog: loadCatalog(catalog) });
      return;

    case "persist":
      writeSpec(msg.spec);
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
      const infra = await import("../shared/infra.mjs");
      const out = infra.compileManifests(msg.spec);
      const baseDir = path.dirname(specPath());
      for (const f of out) {
        const p = path.join(baseDir, f.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, f.content);
      }
      writeSpec(msg.spec);
      post({ type: "manifestsWritten", dir: vscode.workspace.asRelativePath(path.join(baseDir, "deploy")), count: out.length });
      return;
    }

    case "chat":
      await runAssistantTurn(chat, catalog, msg.text, msg.spec);
      return;

    case "deriveLLM":
      // Use the LLM to derive a view from the architecture where there's no clean
      // structural mapping (e.g. flows). It edits via the real tools.
      await runAssistantTurn(chat, catalog, deriveInstruction(msg.view), msg.spec);
      return;

    case "generateOptions":
      await generateOptions(ir, chat, catalog, msg.spec);
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
// actually has a key (so an existing OpenAI key works without touching settings).
async function resolveLlm() {
  let provider = config().get("provider") || "anthropic";
  let key = await apiKey(provider);
  if (!key) {
    const other = provider === "anthropic" ? "openai" : "anthropic";
    const otherKey = await apiKey(other);
    if (otherKey) { provider = other; key = otherKey; }
  }
  const model = provider === "openai" ? config().get("openaiModel") : config().get("model");
  return { provider, key, model };
}

// Run one streaming assistant turn (used by chat and by LLM-derivation).
async function runAssistantTurn(chat, catalog, userText, spec) {
  post({ type: "chatStart" });
  const { provider, key, model } = await resolveLlm();
  const result = await chat.runAssistant({
    userText, spec, provider, model, apiKey: key,
    catalog: loadCatalog(catalog),
    onEvent: post, // streams { type: "chatToken" | "specPatch", ... } to the webview
  });
  writeSpec(result.spec);
  post({ type: "chatDone", text: result.text, spec: result.spec, trace: result.trace });
}

// Generate candidate architectures from the captured requirements — each built
// in isolation (a fresh seed) so the live canvas isn't touched, optimized for a
// different angle. The human is the judge; we present rationale + tradeoffs.
const OPTION_ANGLES = [
  { id: "pragmatic", label: "Pragmatic", desc: "the simplest design that fully meets the requirements, minimal moving parts" },
  { id: "scalable", label: "Scalable", desc: "maximum scalability and resilience, even at higher complexity/cost" },
  { id: "lean", label: "Lean / low-cost", desc: "lowest cost and operational overhead, managed services where possible" },
];

function requirementsText(spec) {
  const reqs = (spec.notes || []).filter((n) => n.kind === "functional" || n.kind === "non_functional");
  if (!reqs.length) return "(no explicit requirements captured — infer reasonable ones from the design title and any existing components)";
  return reqs.map((n) => `- [${n.kind}${n.priority ? "/" + n.priority : ""}] ${n.title}${n.body ? ": " + n.body : ""}`).join("\n");
}

async function generateOptions(ir, chat, catalog, baseSpec) {
  post({ type: "optionsStart", count: OPTION_ANGLES.length });
  const { provider, key, model } = await resolveLlm();
  if (!key) {
    post({ type: "optionsError", message: "The assistant needs an API key. Run “ADR Studio: Set Anthropic API Key” or set a key." });
    return;
  }
  const reqs = requirementsText(baseSpec);
  const options = [];
  for (let i = 0; i < OPTION_ANGLES.length; i++) {
    const angle = OPTION_ANGLES[i];
    post({ type: "optionsProgress", index: i, label: angle.label });
    const seed = ir.emptySpec();
    seed.decision = { ...baseSpec.decision };
    seed.domain_model = baseSpec.domain_model;
    seed.notes = baseSpec.notes || [];
    const instr =
      `Requirements:\n${reqs}\n\nDesign a system architecture optimized for ${angle.desc}. ` +
      `Build it on the architecture view using apply_skill and the arch_* tools — coherent and focused, not exhaustive. ` +
      `When done, reply with a one-paragraph rationale and 2-3 concrete tradeoffs of THIS approach.`;
    try {
      const result = await chat.runAssistant({ userText: instr, spec: seed, provider, model, apiKey: key, catalog: loadCatalog(catalog) });
      options.push({
        id: angle.id,
        label: angle.label,
        rationale: result.text,
        architecture: result.spec.views.architecture,
        components: result.spec.views.architecture.nodes.filter((n) => !n.parent).map((n) => n.label),
      });
    } catch (err) {
      options.push({ id: angle.id, label: angle.label, rationale: `(generation failed: ${err.message})`, architecture: { nodes: [], edges: [] }, components: [] });
    }
  }
  post({ type: "options", options });
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

  const { provider, key, model } = await resolveLlm();
  if (!key) {
    post({ type: "scanError", message: "The assistant needs an API key to read the repo. Run “ADR Studio: Set API Key”." });
    return;
  }

  let scan;
  try {
    scan = await repoScan.scanRepo(repoPath);
  } catch (err) {
    post({ type: "scanError", message: `Could not scan ${repoPath}: ${err.message}` });
    return;
  }

  const seed = ir.emptySpec();
  seed.decision = { ...designSpec.decision };
  const instruction = infer.inferenceInstruction(infer.digestForInference(scan));

  let actual;
  try {
    // Stream tokens (so the user sees progress) but NOT specPatch — the inferred
    // spec is isolated and must not touch the live canvas.
    const result = await chat.runAssistant({
      userText: instruction, spec: seed, provider, model, apiKey: key,
      catalog: loadCatalog(catalog),
      onEvent: (e) => { if (e.type === "chatToken") post({ type: "scanToken", text: e.text }); },
    });
    actual = result.spec;
  } catch (err) {
    post({ type: "scanError", message: `Inference failed: ${err.message}` });
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
    post({ type: "scanDone", repo, count: componentCount });
    return;
  }

  // Existing design → diff, with the full inferred system available to load.
  const report = drift.diffArchitecture(designSpec.views.architecture, actual.views.architecture);
  post({ type: "driftReport", report, actual: actual.views.architecture, full, repo, count: componentCount });
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

function readSpec(ir, schema) {
  const p = specPath();
  if (!fs.existsSync(p)) return ir.emptySpec();
  try {
    const disk = JSON.parse(fs.readFileSync(p, "utf8"));
    // Migrate any legacy shape (0.1.0 research spec, 0.2.0 studio MVP) up to the
    // current multi-view IR. Persist the upgrade so it happens once.
    const { spec, changed, from } = ir.migrate(disk);
    if (changed) {
      writeSpec(spec);
      vscode.window.showInformationMessage(`Upgraded design spec ${from} → ${spec.version}.`);
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
  try {
    if (secrets) {
      const stored = await secrets.get(`adrStudio.${provider}Key`);
      if (stored) return stored;
    }
  } catch {
    /* ignore */
  }
  const envName = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  if (process.env[envName]) return process.env[envName];
  try {
    const cfg = path.join(require("os").homedir(), ".adr", "config.json");
    if (fs.existsSync(cfg)) {
      const j = JSON.parse(fs.readFileSync(cfg, "utf8"));
      if (provider === "openai") return j.OPENAI_API_KEY || j.ADR_OPENAI_API_KEY || null;
      return j.ANTHROPIC_API_KEY || j.ADR_ANTHROPIC_API_KEY || j.anthropicApiKey || null;
    }
  } catch {
    /* ignore */
  }
  return null;
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
