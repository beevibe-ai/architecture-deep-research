// Stateless Anthropic proxy + capsule storage for Crystal Ball v0.
//
// Endpoints
//   POST /api/capsules           — body: raw .jsonl OR { capsule } JSON.
//                                  Returns { id, url, capsule }.
//   GET  /api/capsules/:id       — returns the stored capsule JSON.
//   POST /api/chat               — body: { capsule, history }. Visitor chat,
//                                  stance-inheritance mode.
//   GET  /api/health             — { ok, hasKey, storage }.
//
// Persistence: files under crystal-ball/.capsules/<id>.json (gitignored).
// No accounts, no auth, no expiration — v0 demo only.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { parseFile } from "./src/lib/parser.js";
import { ID_RE, isCapsule, textOfContent } from "./src/lib/schema.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.join(HERE, ".capsules");
const PORT = Number(process.env.PORT || 5274);
const VIEWER_URL = (process.env.CRYSTAL_VIEWER_URL || "http://localhost:5273").replace(/\/$/, "");
const MODEL = process.env.CRYSTAL_BALL_MODEL || "claude-sonnet-4-5";
const MAX_TOKENS = Number(process.env.CRYSTAL_BALL_MAX_TOKENS || 1024);
const MAX_BODY = 10 * 1024 * 1024; // 10 MB

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

await fs.mkdir(STORE_DIR, { recursive: true });

// -------- capsule storage --------------------------------------------------

// 48-bit hex id — large enough that random collision is negligible at v0
// scale, satisfies ID_RE (4..32 alphanumeric).
function newId() {
  return crypto.randomBytes(6).toString("hex");
}

async function saveCapsule(capsule) {
  // Defensive: the only path that calls this should have already set a
  // server-issued id. Reject otherwise so a malformed call can't traverse.
  if (!ID_RE.test(capsule.id || "")) {
    throw new Error("capsule.id missing or not server-issued");
  }
  const file = path.join(STORE_DIR, `${capsule.id}.json`);
  await fs.writeFile(file, JSON.stringify(capsule, null, 2), "utf8");
}

async function loadCapsule(id) {
  if (!ID_RE.test(id)) return null;
  try {
    const text = await fs.readFile(path.join(STORE_DIR, `${id}.json`), "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// -------- handlers ---------------------------------------------------------

// Allowlist of content-types that carry a raw .jsonl session body.
const JSONL_CT = ["application/x-jsonl", "application/jsonl", "application/x-ndjson", "text/plain"];

async function handleCreateCapsule(req, res) {
  const ct = (req.headers["content-type"] || "").toLowerCase().split(";")[0].trim();
  const raw = await readBody(req);

  let capsule;
  let warnings = [];
  try {
    if (ct === "application/json") {
      const body = JSON.parse(raw || "{}");
      if (body.capsule && isCapsule(body.capsule)) {
        capsule = body.capsule;
      } else if (typeof body.rawJsonl === "string") {
        ({ capsule, warnings } = parseFile(body.rawJsonl, body.filename || ""));
      } else if (typeof body.text === "string") {
        ({ capsule, warnings } = parseFile(body.text, body.filename || ""));
      } else {
        return reply(res, 400, "expected { capsule } or { rawJsonl } in JSON body");
      }
    } else if (JSONL_CT.includes(ct)) {
      ({ capsule, warnings } = parseFile(raw, ""));
    } else {
      return reply(
        res,
        415,
        `unsupported content-type: ${ct || "(none)"}. Use application/json with { capsule } / { rawJsonl }, or application/x-jsonl for raw session text.`
      );
    }
  } catch (err) {
    return reply(res, 400, `parse failed: ${err.message || err}`);
  }

  // Server owns id assignment — never trust client-supplied ids for the
  // filesystem path. Closes a path-traversal hole and avoids cross-publisher
  // id collisions from clients that share a tiny id space.
  capsule.id = newId();

  await saveCapsule(capsule);
  const url = `${VIEWER_URL}/c/${capsule.id}`;
  return replyJson(res, 200, { id: capsule.id, url, capsule, warnings });
}

async function handleGetCapsule(res, id) {
  const capsule = await loadCapsule(id);
  if (!capsule) return reply(res, 404, "capsule not found");
  return replyJson(res, 200, capsule);
}

async function handleChat(req, res) {
  const body = JSON.parse((await readBody(req)) || "null");
  if (!body?.capsule || !Array.isArray(body?.history)) {
    return reply(res, 400, "bad request");
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return reply(res, 500, "server is missing ANTHROPIC_API_KEY");
  }
  try {
    const messages = body.history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.text || "",
    }));
    const result = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystem(body.capsule),
      messages,
    });
    const reply_ = (result.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return replyJson(res, 200, { reply: reply_ });
  } catch (err) {
    return reply(res, 500, `upstream error: ${err.message || err}`);
  }
}

// -------- system prompt (stance inheritance) -------------------------------

function flattenCapsule(capsule) {
  const lines = [];
  for (const e of capsule.events || []) {
    if (e.type === "message") {
      const text = textOfContent(e.content);
      if (!text) continue;
      lines.push(`[${e.role}] ${text}`);
    } else if (e.type === "tool_use") {
      lines.push(
        `[tool:${e.name}${e.ok === false ? " FAILED" : ""}] ${
          e.input ? JSON.stringify(e.input).slice(0, 400) : ""
        }`
      );
      if (e.result) lines.push(`[result] ${String(e.result).slice(0, 400)}`);
    } else if (e.type === "file_change") {
      lines.push(`[edit] ${e.path}\n${(e.diff || "").slice(0, 600)}`);
    } else if (e.type === "thinking") {
      const thought = String(e.content || "");
      if (thought) lines.push(`[thinking] ${thought.slice(0, 400)}`);
    }
  }
  const joined = lines.join("\n");
  return joined.length > 60000 ? "…[earlier omitted]\n" + joined.slice(-60000) : joined;
}

function buildSystem(capsule) {
  const session = flattenCapsule(capsule);
  return [
    `You are the voice of a Crystal Ball capsule — a frozen snapshot of an AI`,
    `collaboration session that the publisher chose to share. Visitors ask`,
    `questions and you answer as a continuation of the publisher's reasoning,`,
    `not as a neutral narrator.`,
    ``,
    `Rules:`,
    `1. Speak from the publisher's stance and conclusions. Use "I" / "we" as`,
    `   the publisher would. Don't say "the publisher decided X" — say "I went`,
    `   with X because…".`,
    `2. Ground every answer in the session below. If the answer isn't in the`,
    `   session, say so plainly — don't invent.`,
    `3. Be concise. Prefer the form: claim, then the specific moment in the`,
    `   session that supports it.`,
    `4. You may extrapolate one step beyond the session if asked ("what would`,
    `   you do next?"), but mark it as your extrapolation.`,
    ``,
    `Capsule title: ${capsule.title || "(untitled)"}`,
    `Outcome: ${capsule.metadata?.outcome || "unknown"}`,
    `Topics: ${(capsule.metadata?.topics || []).join(", ") || "—"}`,
    ``,
    `--- SESSION ---`,
    session,
    `--- END SESSION ---`,
  ].join("\n");
}

// -------- helpers ----------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function reply(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(text);
}
function replyJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// -------- router -----------------------------------------------------------

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      return replyJson(res, 200, {
        ok: true,
        hasKey: !!process.env.ANTHROPIC_API_KEY,
        storage: STORE_DIR,
        viewerUrl: VIEWER_URL,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/capsules") {
      return await handleCreateCapsule(req, res);
    }
    const get = url.pathname.match(/^\/api\/capsules\/([a-z0-9]{4,32})$/i);
    if (req.method === "GET" && get) {
      return await handleGetCapsule(res, get[1]);
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      return await handleChat(req, res);
    }
    return reply(res, 404, "not found");
  } catch (err) {
    return reply(res, 500, `server error: ${err.message || err}`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`crystal-ball server on http://127.0.0.1:${PORT}`);
  console.log(`  storage:  ${STORE_DIR}`);
  console.log(`  viewer:   ${VIEWER_URL}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("WARN: ANTHROPIC_API_KEY not set — /api/chat returns 500.");
  }
});
