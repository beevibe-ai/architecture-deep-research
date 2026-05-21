import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: response.status, body };
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 8_000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await fetchJson(url);
      if (result.status === 200 && result.body?.ok) return result.body;
    } catch (error) {
      lastError = error;
    }
    await wait(150);
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms (${lastError?.message || ""})`);
}

const port = 4751;
const runsDir = join(projectRoot, ".smoke-runs");
const distDir = join(projectRoot, "web/dist");
await mkdir(runsDir, { recursive: true });

// Synthesize a tiny finished run on disk so we can exercise summary + artifact endpoints.
const sampleId = "smoke-sample";
const sampleDir = join(runsDir, sampleId);
await mkdir(sampleDir, { recursive: true });
await writeFile(
  join(sampleDir, "state.json"),
  JSON.stringify(
    {
      version: "0.2.0",
      status: "completed",
      completed_at: new Date().toISOString(),
      selected_topology: "graphrag",
      evidence_count: 7,
      promoted_candidate_count: 1,
      handoff_boundary: "adr_stops_at_execution_handoff"
    },
    null,
    2
  )
);
await writeFile(
  join(sampleDir, "events.jsonl"),
  [
    JSON.stringify({ ts: new Date().toISOString(), type: "run_started" }),
    JSON.stringify({ ts: new Date().toISOString(), type: "evidence_collected", evidence_count: 7 }),
    JSON.stringify({ ts: new Date().toISOString(), type: "run_completed", selected_topology: "graphrag" })
  ].join("\n") + "\n"
);
await writeFile(
  join(sampleDir, "strategic-context.json"),
  JSON.stringify({ domain: "test", decision: "smoke" }, null, 2)
);

const child = spawn(
  process.execPath,
  ["scripts/adr-web.mjs", "--runs", runsDir, "--port", String(port), "--dist", distDir],
  { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], env: process.env }
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));

let exitCode = null;
child.on("exit", (code) => {
  exitCode = code;
});

try {
  const base = `http://127.0.0.1:${port}`;
  const health = await waitForServer(`${base}/api/health`);
  if (health.port !== port) {
    throw new Error(`health endpoint reports wrong port: ${JSON.stringify(health)}`);
  }

  const runs = await fetchJson(`${base}/api/runs`);
  if (runs.status !== 200 || !Array.isArray(runs.body?.runs)) {
    throw new Error(`/api/runs returned unexpected payload: ${JSON.stringify(runs)}`);
  }
  if (!runs.body.runs.some((r) => r.id === sampleId)) {
    throw new Error(`/api/runs did not include the synthesized run: ${JSON.stringify(runs.body)}`);
  }

  const single = await fetchJson(`${base}/api/runs/${sampleId}`);
  if (single.status !== 200 || single.body.selected_topology !== "graphrag") {
    throw new Error(`/api/runs/:id payload missing fields: ${JSON.stringify(single.body)}`);
  }
  if (!Array.isArray(single.body.artifacts) || !single.body.artifacts.includes("state.json")) {
    throw new Error(`/api/runs/:id did not list state.json as an artifact`);
  }

  const stateArtifact = await fetchJson(`${base}/api/runs/${sampleId}/artifact/state.json`);
  if (stateArtifact.status !== 200 || stateArtifact.body.selected_topology !== "graphrag") {
    throw new Error(`state.json artifact endpoint payload unexpected`);
  }

  const eventsArtifact = await fetchJson(`${base}/api/runs/${sampleId}/artifact/events.jsonl`);
  if (
    eventsArtifact.status !== 200 ||
    !Array.isArray(eventsArtifact.body.events) ||
    eventsArtifact.body.events.length !== 3
  ) {
    throw new Error(`events.jsonl artifact endpoint did not return 3 events`);
  }

  const notFound = await fetchJson(`${base}/api/runs/does-not-exist`);
  if (notFound.status !== 404) {
    throw new Error(`expected 404 for missing run, got ${notFound.status}`);
  }

  const unknownArtifact = await fetchJson(`${base}/api/runs/${sampleId}/artifact/bogus.json`);
  if (unknownArtifact.status !== 400) {
    throw new Error(`expected 400 for unknown artifact, got ${unknownArtifact.status}`);
  }

  // SPA fallback: a non-API path returns built index.html (if built) or a 404 JSON otherwise.
  const indexResponse = await fetch(`${base}/runs/${sampleId}`);
  const indexText = await indexResponse.text();
  const distIndex = await readFile(join(distDir, "index.html"), "utf8").catch(() => null);
  if (distIndex) {
    if (indexResponse.status !== 200) {
      throw new Error(`SPA fallback should return 200 when web/dist is built, got ${indexResponse.status}`);
    }
    if (!indexText.includes("<div id=\"root\"")) {
      throw new Error(`SPA fallback did not return the React shell`);
    }
  }

  console.log("web smoke ok");
} catch (error) {
  console.error("web smoke FAILED:", error?.message || error);
  if (stdout) console.error("server stdout:\n" + stdout);
  if (stderr) console.error("server stderr:\n" + stderr);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await wait(150);
  if (exitCode === null) child.kill("SIGKILL");
  await rm(runsDir, { recursive: true, force: true });
}
