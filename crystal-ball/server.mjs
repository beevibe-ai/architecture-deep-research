// Minimal stateless API server for Crystal Ball v0.
//
// Only endpoint: POST /api/chat
//   body: { capsule, history: [{role, text}] }
//   reply: { reply: string }
//
// The model is instructed to answer as a continuation of the publisher's
// reasoning — i.e. stance inheritance, not neutral narration. Capsule events
// are flattened into the system prompt; visitor history becomes a normal
// user/assistant exchange.

import http from "node:http";
import Anthropic from "@anthropic-ai/sdk";

const PORT = Number(process.env.PORT || 5274);
const MODEL = process.env.CRYSTAL_BALL_MODEL || "claude-sonnet-4-5";
const MAX_TOKENS = Number(process.env.CRYSTAL_BALL_MAX_TOKENS || 1024);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function flattenCapsule(capsule) {
  const lines = [];
  for (const e of capsule.events || []) {
    if (e.type === "message") {
      const text = textOf(e.content);
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
      lines.push(`[thinking] ${e.content.slice(0, 400)}`);
    }
  }
  // Hard cap so we don't blow context. Tail-biased: recent events matter more.
  const joined = lines.join("\n");
  return joined.length > 60000 ? "…[earlier omitted]\n" + joined.slice(-60000) : joined;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
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

async function handleChat(req, res) {
  const body = await readJson(req);
  if (!body?.capsule || !Array.isArray(body?.history)) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("bad request");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("server is missing ANTHROPIC_API_KEY");
    return;
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
    const reply = (result.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ reply }));
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`upstream error: ${err.message || err}`);
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }
  res.setHeader("access-control-allow-origin", "*");

  if (req.method === "POST" && req.url === "/api/chat") {
    await handleChat(req, res);
    return;
  }
  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, hasKey: !!process.env.ANTHROPIC_API_KEY }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`crystal-ball server on http://127.0.0.1:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "WARN: ANTHROPIC_API_KEY not set — /api/chat will return 500 until it is."
    );
  }
});
