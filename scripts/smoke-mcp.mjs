#!/usr/bin/env node
// Smoke test for the ADR MCP server. Boots the server as a subprocess, opens
// a client over stdio, calls list_tools, and then exercises adr_discover via
// the kernel's setLlmJsonProvider fixture path. No network. Used by
// `npm run smoke:mcp` and folded into `npm test`.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "adr-mcp.mjs");

// We can't easily install setLlmJsonProvider across the subprocess boundary
// (the server is a separate process). For the smoke test we only assert the
// structural shape: server boots, lists tools, and rejects an actual
// adr_discover call cleanly because no LLM provider is configured.
//
// The functional path through discoverPatterns is already covered by
// scripts/kernel-regression-tests.mjs against the in-process kernel.

const repoDir = await mkdtemp(path.join(os.tmpdir(), "adr-mcp-smoke-"));
await writeFile(path.join(repoDir, "README.md"), "# smoke test repo\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath]
});
const client = new Client(
  { name: "adr-mcp-smoke", version: "1.0.0" },
  { capabilities: {} }
);

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = ["adr_deep_research", "adr_discover", "adr_read_handoff"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(
      `MCP server exposed unexpected tools. Got ${JSON.stringify(names)}, expected ${JSON.stringify(expected)}.`
    );
  }
  for (const tool of tools) {
    if (!tool.inputSchema || !tool.description) {
      throw new Error(`Tool ${tool.name} is missing schema or description.`);
    }
  }

  // Call adr_discover with no LLM provider configured. The server should
  // return an isError result with the kernel's runtime check message — not
  // crash and not silently succeed.
  const discoverOut = await mkdtemp(path.join(os.tmpdir(), "adr-mcp-discover-"));
  const result = await client.callTool({
    name: "adr_discover",
    arguments: {
      repo_path: repoDir,
      decision: "smoke test",
      out_dir: discoverOut
    }
  });
  if (!result.isError) {
    throw new Error(
      "adr_discover should have failed at the LLM runtime check (no provider configured) but returned success."
    );
  }
  const errText = result.content?.[0]?.text || "";
  if (!errText.includes("LLM synthesis provider")) {
    throw new Error(
      `adr_discover error did not mention the LLM provider gate. Got: ${errText.slice(0, 200)}`
    );
  }
  await rm(discoverOut, { recursive: true, force: true });

  // Unknown tool returns isError, not crash.
  const bad = await client.callTool({ name: "adr_nonexistent", arguments: {} });
  if (!bad.isError) {
    throw new Error("Unknown tool should have returned isError.");
  }
} finally {
  await client.close();
  await rm(repoDir, { recursive: true, force: true });
}

console.log("mcp smoke ok");
