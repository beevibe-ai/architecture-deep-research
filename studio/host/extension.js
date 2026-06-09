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
      chat: await import("./chat.mjs"),
    }))();
  }
  return sharedPromise;
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("adrStudio.open", () => openCanvas(context))
  );
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

  panel.onDidDispose(() => {
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
  const { ir, handoff, plan, chat } = await shared();
  switch (msg.type) {
    case "ready":
      post({ type: "spec", spec: readSpec(ir) });
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

    case "writePlan": {
      const md = plan.generatePlan(msg.spec);
      const out = planPath();
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, md);
      writeSpec(msg.spec);
      post({ type: "planWritten", path: vscode.workspace.asRelativePath(out) });
      return;
    }

    case "chat": {
      post({ type: "chatStart" });
      const result = await chat.runAssistant({
        userText: msg.text,
        spec: msg.spec,
        model: config().get("model"),
        apiKey: apiKey(),
        onEvent: post, // streams { type: "chatToken" | "specPatch", ... } to the webview
      });
      writeSpec(result.spec);
      post({ type: "chatDone", text: result.text, spec: result.spec, trace: result.trace });
      return;
    }

    default:
      return;
  }
}

function post(message) {
  if (panel) panel.webview.postMessage(message);
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

function readSpec(ir) {
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
    return spec;
  } catch (err) {
    vscode.window.showWarningMessage(`Could not parse spec, starting fresh: ${err.message}`);
    return ir.emptySpec();
  }
}

function writeSpec(spec) {
  const p = specPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(spec, null, 2));
}

function apiKey() {
  // Reuse the same key adr-doctor persists, then env, then nothing (chat
  // degrades to a clear error rather than a mock response).
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv) return fromEnv;
  try {
    const cfg = path.join(require("os").homedir(), ".adr", "config.json");
    if (fs.existsSync(cfg)) {
      const j = JSON.parse(fs.readFileSync(cfg, "utf8"));
      return j.ANTHROPIC_API_KEY || j.anthropicApiKey || null;
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
