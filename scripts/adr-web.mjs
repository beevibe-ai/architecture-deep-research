#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream, watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import http from "node:http";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }
  return flags;
}

function usage() {
  return `Usage:
  adr-web [--runs <dir>] [--port <n>] [--host <h>] [--dist <dir>] [--open]

Defaults:
  --runs .adr-runs           runs directory to expose
  --port 4173                http port
  --host 127.0.0.1
  --dist web/dist            built UI files (built via \`npm run web:build\`)

Endpoints:
  GET  /api/runs                  list runs
  GET  /api/runs/:id              run summary + available artifacts
  GET  /api/runs/:id/artifact/:n  load a single artifact
  GET  /api/runs/:id/events       tail events.jsonl via Server-Sent Events
  POST /api/runs                  start a new run (CLI-compatible body)
`;
}

const flags = parseArgs(process.argv.slice(2));
if (flags.help || flags.h) {
  console.log(usage());
  process.exit(0);
}

const runsDir = resolve(projectRoot, flags.runs || ".adr-runs");
const port = Number(flags.port || process.env.PORT || 4173);
const host = String(flags.host || "127.0.0.1");
const distDir = resolve(projectRoot, flags.dist || "web/dist");

const KNOWN_ARTIFACTS = [
  "state.json",
  "strategic-context.json",
  "clarification.json",
  "research-plan.json",
  "evidence.json",
  "knowledge-map.json",
  "comparison-matrix.json",
  "intermediate-reports.md",
  "critique.json",
  "citation-audit.json",
  "claim-audit.json",
  "ADR.md",
  "architecture.spec.json",
  "domain-evaluation-pack.json",
  "agent-guardrails.md",
  "execution-handoff.json",
  "research-report.md",
  "sources.md",
  "events.jsonl"
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};

function safeJoin(base, ...parts) {
  const joined = normalize(join(base, ...parts));
  const rel = relative(base, joined);
  if (rel.startsWith("..") || rel.includes(`..${join("/").length ? "/" : ""}`)) {
    return null;
  }
  return joined;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  res.end(payload);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function listRuns() {
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const runPath = join(runsDir, entry.name);
    const summary = await summarizeRun(entry.name, runPath);
    if (summary) runs.push(summary);
  }
  runs.sort((a, b) => (b.completed_at || b.modified_at || "").localeCompare(a.completed_at || a.modified_at || ""));
  return runs;
}

async function summarizeRun(id, runPath) {
  const statePath = join(runPath, "state.json");
  let state = null;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    state = null;
  }
  let modified_at = null;
  try {
    const stats = await stat(runPath);
    modified_at = stats.mtime.toISOString();
  } catch {
    /* ignore */
  }
  const available = [];
  await Promise.all(
    KNOWN_ARTIFACTS.map(async (name) => {
      try {
        await stat(join(runPath, name));
        available.push(name);
      } catch {
        /* missing */
      }
    })
  );
  return {
    id,
    state,
    status: state?.status || (available.length > 0 ? "in_progress" : "unknown"),
    selected_topology: state?.selected_topology || null,
    evidence_count: state?.evidence_count || null,
    promoted_candidate_count: state?.promoted_candidate_count || null,
    completed_at: state?.completed_at || null,
    modified_at,
    artifacts: available
  };
}

async function getArtifact(runPath, artifactName) {
  if (!KNOWN_ARTIFACTS.includes(artifactName)) return { status: 400, body: { error: "unknown_artifact" } };
  const artifactPath = safeJoin(runPath, artifactName);
  if (!artifactPath) return { status: 400, body: { error: "invalid_path" } };
  try {
    const buffer = await readFile(artifactPath, "utf8");
    if (artifactName.endsWith(".json")) {
      try {
        return { status: 200, body: JSON.parse(buffer) };
      } catch {
        return { status: 200, body: { raw: buffer } };
      }
    }
    if (artifactName === "events.jsonl") {
      const events = buffer
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { raw: line };
          }
        });
      return { status: 200, body: { events } };
    }
    return { status: 200, body: { markdown: buffer } };
  } catch (error) {
    if (error.code === "ENOENT") return { status: 404, body: { error: "not_found" } };
    return { status: 500, body: { error: String(error?.message || error) } };
  }
}

async function streamEvents(req, res, runPath) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  res.flushHeaders?.();

  const eventsPath = safeJoin(runPath, "events.jsonl");
  if (!eventsPath) {
    res.end();
    return;
  }

  let position = 0;
  let buffer = "";
  let closed = false;

  function emit(rawLine) {
    if (!rawLine) return;
    res.write(`data: ${rawLine}\n\n`);
  }

  function flushBuffer() {
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) emit(line);
    }
  }

  async function readFrom() {
    return new Promise((resolveRead, rejectRead) => {
      let stream;
      try {
        stream = createReadStream(eventsPath, { start: position, encoding: "utf8" });
      } catch (error) {
        if (error.code === "ENOENT") {
          resolveRead();
          return;
        }
        rejectRead(error);
        return;
      }
      stream.on("data", (chunk) => {
        position += Buffer.byteLength(chunk, "utf8");
        buffer += chunk;
        flushBuffer();
      });
      stream.on("error", (error) => {
        if (error.code === "ENOENT") {
          resolveRead();
          return;
        }
        rejectRead(error);
      });
      stream.on("end", resolveRead);
    });
  }

  try {
    await readFrom();
  } catch (error) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: String(error?.message || error) })}\n\n`);
  }
  emit(JSON.stringify({ type: "live_tail_started", ts: new Date().toISOString() }));

  let watcher;
  let pending = false;
  function schedule() {
    if (closed || pending) return;
    pending = true;
    setTimeout(async () => {
      pending = false;
      if (closed) return;
      try {
        await readFrom();
      } catch (error) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: String(error?.message || error) })}\n\n`);
      }
    }, 50);
  }

  try {
    watcher = watch(eventsPath, { persistent: false }, () => schedule());
  } catch (error) {
    if (error.code !== "ENOENT") {
      res.write(`event: error\ndata: ${JSON.stringify({ message: String(error?.message || error) })}\n\n`);
    }
  }

  const heartbeat = setInterval(() => {
    if (closed) return;
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);

  req.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    try {
      watcher?.close();
    } catch {
      /* ignore */
    }
    res.end();
  });
}

async function startRun(body) {
  const {
    inputPath,
    domain,
    decision,
    outDir,
    runtime = "openai",
    model,
    flags: extraFlags = {}
  } = body || {};
  if (!inputPath || !domain || !decision || !outDir) {
    return { status: 400, body: { error: "inputPath/domain/decision/outDir required" } };
  }
  const cliMap = {
    openai: ["scripts/adr.mjs", "deep-research"],
    langgraph: ["scripts/adr-langgraph.mjs"],
    adk: ["scripts/adr-adk.mjs"]
  };
  const cli = cliMap[runtime];
  if (!cli) return { status: 400, body: { error: `unknown_runtime: ${runtime}` } };
  const args = [
    ...cli,
    String(inputPath),
    "--domain",
    String(domain),
    "--decision",
    String(decision),
    "--out",
    String(outDir)
  ];
  if (model) args.push("--model", String(model));
  for (const [key, value] of Object.entries(extraFlags)) {
    if (value === true) {
      args.push(`--${key}`);
    } else if (value !== false && value !== null && value !== undefined) {
      args.push(`--${key}`, String(value));
    }
  }
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env
  });
  child.unref();
  return {
    status: 202,
    body: {
      started: true,
      pid: child.pid,
      runtime,
      args
    }
  };
}

async function readRequestJson(req) {
  return new Promise((resolveRead, rejectRead) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 256_000) {
        rejectRead(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const buffer = Buffer.concat(chunks).toString("utf8");
      if (!buffer) {
        resolveRead({});
        return;
      }
      try {
        resolveRead(JSON.parse(buffer));
      } catch (error) {
        rejectRead(error);
      }
    });
    req.on("error", rejectRead);
  });
}

async function serveStatic(req, res) {
  let pathname = decodeURIComponent(req.url.split("?")[0]);
  if (pathname === "/" || pathname === "") pathname = "/index.html";
  const filePath = safeJoin(distDir, "." + pathname);
  if (!filePath) return false;
  try {
    const stats = await stat(filePath);
    if (stats.isDirectory()) return serveStatic(req, { ...res, url: pathname + "/index.html" });
    const ext = extname(filePath);
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": stats.size,
      "cache-control": "no-store"
    });
    createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

async function serveSpaFallback(res) {
  const indexPath = safeJoin(distDir, "index.html");
  if (!indexPath) {
    sendError(res, 404, "ui not built; run `npm run web:build` first");
    return;
  }
  try {
    const html = await readFile(indexPath, "utf8");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      "cache-control": "no-store"
    });
    res.end(html);
  } catch {
    sendError(res, 404, "ui not built; run `npm run web:build` first");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const { pathname } = url;

    if (pathname === "/api/health") {
      sendJson(res, 200, { ok: true, runsDir, port, host });
      return;
    }

    if (req.method === "GET" && pathname === "/api/runs") {
      const runs = await listRuns();
      sendJson(res, 200, { runs });
      return;
    }

    if (req.method === "POST" && pathname === "/api/runs") {
      try {
        const body = await readRequestJson(req);
        const result = await startRun(body);
        sendJson(res, result.status, result.body);
      } catch (error) {
        sendError(res, 400, String(error?.message || error));
      }
      return;
    }

    const runMatch = pathname.match(/^\/api\/runs\/([^\/]+)(\/.*)?$/);
    if (runMatch) {
      const id = decodeURIComponent(runMatch[1]);
      const runPath = safeJoin(runsDir, id);
      if (!runPath) {
        sendError(res, 400, "invalid run id");
        return;
      }
      let runExists;
      try {
        runExists = (await stat(runPath)).isDirectory();
      } catch {
        runExists = false;
      }
      if (!runExists) {
        sendError(res, 404, "run not found");
        return;
      }

      const sub = runMatch[2] || "";
      if (sub === "" || sub === "/") {
        const summary = await summarizeRun(id, runPath);
        sendJson(res, 200, summary);
        return;
      }
      if (sub === "/events") {
        streamEvents(req, res, runPath);
        return;
      }
      const artifactMatch = sub.match(/^\/artifact\/([^\/]+)$/);
      if (artifactMatch) {
        const artifactName = decodeURIComponent(artifactMatch[1]);
        const result = await getArtifact(runPath, artifactName);
        sendJson(res, result.status, result.body);
        return;
      }
      sendError(res, 404, "unknown endpoint");
      return;
    }

    if (req.method !== "GET") {
      sendError(res, 405, "method not allowed");
      return;
    }

    const served = await serveStatic(req, res);
    if (served) return;
    await serveSpaFallback(res);
  } catch (error) {
    sendError(res, 500, String(error?.message || error));
  }
});

server.listen(port, host, () => {
  console.log(`adr-web listening on http://${host}:${port}`);
  console.log(`runs dir: ${runsDir}`);
  console.log(`ui dist:  ${distDir}`);
  if (flags.open) {
    const url = `http://${host}:${port}/`;
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
  }
});

export { server };
