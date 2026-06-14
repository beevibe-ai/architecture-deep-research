import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { __resetIds } from "../shared/ir.mjs";
import { architectureFromScan } from "./infer.mjs";

beforeEach(() => __resetIds(0));

test("architectureFromScan builds a grounded baseline when LLM inference is unavailable", () => {
  const spec = architectureFromScan({
    tree: [
      { kind: "dir", path: "packages/web" },
      { kind: "dir", path: "packages/api" },
      { kind: "dir", path: "packages/daemon" },
      { kind: "dir", path: "packages/mcp-server" },
    ],
    manifests: [{
      path: "package.json",
      content: JSON.stringify({
        dependencies: {
          next: "^15.0.0",
          express: "^5.0.0",
          pg: "^8.0.0",
          "@anthropic-ai/sdk": "^0.32.1",
        },
      }),
    }],
    deploy_configs: [{
      path: "docker-compose.yml",
      content: "services:\n  postgres:\n    image: pgvector/pgvector:pg16\n",
    }],
    schema_sources: [{
      path: "migrations/001.sql",
      content: "CREATE TABLE memory_fact (id text primary key, embedding vector(1536));",
    }],
    route_sources: [{
      path: "packages/api/src/routes/mcp.ts",
      content: `
        router.post("/", async (req, res) => {
          await pool.query("INSERT INTO task (id) VALUES ($1)");
          await pool.query("SELECT pg_notify('task_events', 'x')");
          res.json({ ok: true });
        });
      `,
    }],
  });

  const labels = spec.views.architecture.nodes.map((n) => n.label);
  for (const label of ["Web Client", "API Service", "Agent Runtime", "Daemon", "MCP Server", "Postgres Database", "LLM Provider"]) {
    assert.ok(labels.includes(label), `expected ${label}`);
  }
  assert.equal(labels.includes("Postgres Event Bus"), false, "LISTEN/NOTIFY should stay an edge mechanism, not a top-level bus");
  const runtime = spec.views.architecture.nodes.find((n) => n.label === "Agent Runtime");
  const daemon = spec.views.architecture.nodes.find((n) => n.label === "Daemon");
  assert.equal(daemon.parent, runtime.id);

  const edge = (from, to, protocol) => spec.views.architecture.edges.some((e) => {
    const f = spec.views.architecture.nodes.find((n) => n.id === e.from)?.label;
    const t = spec.views.architecture.nodes.find((n) => n.id === e.to)?.label;
    return f === from && t === to && e.protocol === protocol;
  });
  assert.equal(edge("Web Client", "API Service", "http"), true);
  assert.equal(edge("API Service", "Postgres Database", "sql"), true);
  assert.equal(edge("API Service", "MCP Server", "http"), true);
  assert.equal(edge("Postgres Database", "Agent Runtime", "event"), true);
  assert.equal(spec.views.architecture.edges.some((e) => e.label === "LISTEN/NOTIFY"), true);

  const distinctPositions = new Set(spec.views.architecture.nodes.map((n) => `${n.position.x},${n.position.y}`));
  assert.equal(distinctPositions.size, spec.views.architecture.nodes.length);
});
