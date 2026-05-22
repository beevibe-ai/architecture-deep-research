#!/usr/bin/env node
// Test matrix for searchWithProvider: stub globalThis.fetch, set each
// provider env-var in turn, assert the normalized { title, url, snippet,
// provider } shape comes back. Covers the OpenAI web_search fallback added
// in 42f14af which previously had zero coverage.
import assert from "node:assert/strict";

// Track every fetch call for assertions.
const fetchCalls = [];
function stubFetch(handler) {
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input: String(input), init });
    return handler(String(input), init);
  };
}
function resetFetchCalls() {
  fetchCalls.length = 0;
}
function clearSearchEnv() {
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.SERPER_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.SEARXNG_URL;
  delete process.env.ADR_MCP_SERVER_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ADR_OPENAI_API_KEY;
  delete process.env.ADR_SEARCH_PROVIDER;
  delete process.env.ADR_PRIVATE_MCP_ONLY;
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

clearSearchEnv();

// Import kernel AFTER clearing env so it doesn't capture a stale state.
// (searchWithProvider re-reads env on every call, so order doesn't matter
// for correctness, but the clear up-front makes the test self-contained.)
const { activeSearchProviders } = await import("../src/kernel.mjs");
// activeSearchProviders is read here just to confirm the import wired.
assert.equal(typeof activeSearchProviders, "function");

// searchWithProvider is not exported; reach in via a fresh module import
// after env mutation. Simpler path: exercise gatherEvidenceForQuery's
// underlying call via the public adapter. Since the kernel doesn't expose
// searchWithProvider directly, we test the OpenAI web_search and MCP
// branches by importing the module and stubbing fetch around a contrived
// search.

import { searchWithProvider } from "../src/kernel.mjs";

async function withEnv(env, fn) {
  const snapshot = {};
  for (const key of Object.keys(env)) {
    snapshot[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(snapshot)) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }
}

try {
  // ---------- Brave ----------
  clearSearchEnv();
  resetFetchCalls();
  stubFetch(async (url) => {
    assert.ok(url.startsWith("https://api.search.brave.com/res/v1/web/search"));
    return jsonResponse({
      web: {
        results: [
          { title: "Brave hit", url: "https://example.com/a", description: "snippet" }
        ]
      }
    });
  });
  let results = await withEnv({ BRAVE_SEARCH_API_KEY: "x" }, () =>
    searchWithProvider("test query")
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].provider, "brave");
  assert.equal(results[0].url, "https://example.com/a");
  assert.equal(results[0].snippet, "snippet");

  // ---------- Serper ----------
  clearSearchEnv();
  resetFetchCalls();
  stubFetch(async (url) => {
    assert.equal(url, "https://google.serper.dev/search");
    return jsonResponse({
      organic: [
        { title: "Serper hit", link: "https://example.com/b", snippet: "serper snippet" }
      ]
    });
  });
  results = await withEnv({ SERPER_API_KEY: "x" }, () => searchWithProvider("test"));
  assert.equal(results[0].provider, "serper");
  assert.equal(results[0].url, "https://example.com/b");
  assert.equal(results[0].snippet, "serper snippet");

  // ---------- Tavily ----------
  clearSearchEnv();
  resetFetchCalls();
  stubFetch(async (url) => {
    assert.equal(url, "https://api.tavily.com/search");
    return jsonResponse({
      results: [
        { title: "Tavily hit", url: "https://example.com/c", content: "tavily content" }
      ]
    });
  });
  results = await withEnv({ TAVILY_API_KEY: "x" }, () => searchWithProvider("test"));
  assert.equal(results[0].provider, "tavily");
  assert.equal(results[0].snippet, "tavily content");

  // ---------- SearXNG ----------
  clearSearchEnv();
  resetFetchCalls();
  stubFetch(async (url) => {
    assert.ok(url.startsWith("https://searx.example.com/search"));
    return jsonResponse({
      results: [
        { title: "Searx hit", url: "https://example.com/d", content: "searx content" }
      ]
    });
  });
  results = await withEnv({ SEARXNG_URL: "https://searx.example.com" }, () =>
    searchWithProvider("test")
  );
  assert.equal(results[0].provider, "searxng");
  assert.equal(results[0].url, "https://example.com/d");

  // ---------- OpenAI web_search (annotations present) ----------
  clearSearchEnv();
  resetFetchCalls();
  stubFetch(async (url) => {
    assert.ok(url.endsWith("/responses"));
    return jsonResponse({
      output: [
        {
          type: "message",
          content: [
            {
              text: "GraphRAG is a graph-augmented retrieval architecture.",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://microsoft.github.io/graphrag/?utm_source=openai",
                  title: "GraphRAG",
                  start_index: 0,
                  end_index: 49
                }
              ]
            }
          ]
        }
      ]
    });
  });
  results = await withEnv({ OPENAI_API_KEY: "x" }, () => searchWithProvider("graphrag"));
  assert.equal(results.length, 1);
  assert.equal(results[0].provider, "openai-web-search");
  // utm_source=openai stripped:
  assert.equal(results[0].url, "https://microsoft.github.io/graphrag/");
  assert.equal(results[0].title, "GraphRAG");
  assert.ok(results[0].snippet.startsWith("GraphRAG is a graph-augmented"));

  // ---------- OpenAI web_search (zero annotations → empty, no fabrication) ----------
  clearSearchEnv();
  resetFetchCalls();
  // Silence the expected console.warn from the empty-annotation path.
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    stubFetch(async () =>
      jsonResponse({
        output: [
          {
            type: "message",
            content: [
              {
                text: "I don't have any sources for that query.",
                annotations: []
              }
            ]
          }
        ]
      })
    );
    results = await withEnv({ OPENAI_API_KEY: "x" }, () => searchWithProvider("nothing"));
    assert.deepEqual(results, [], "zero annotations must yield zero results, not fabricated evidence");
  } finally {
    console.warn = originalWarn;
  }

  // ---------- MCP empty → empty (no mcp://<label>/<hash> fabrication) ----------
  clearSearchEnv();
  resetFetchCalls();
  console.warn = () => {};
  try {
    stubFetch(async () =>
      jsonResponse({
        output: [
          {
            type: "message",
            content: [
              {
                text: "No corpus hit for that.",
                annotations: []
              }
            ]
          }
        ]
      })
    );
    results = await withEnv(
      {
        OPENAI_API_KEY: "x",
        ADR_MCP_SERVER_URL: "https://mcp.example.com",
        ADR_SEARCH_PROVIDER: "mcp"
      },
      () => searchWithProvider("private corpus query")
    );
    assert.deepEqual(
      results,
      [],
      "MCP zero annotations must yield zero results, not a fabricated mcp:// URL"
    );
  } finally {
    console.warn = originalWarn;
  }

  // ---------- No provider configured → throws ----------
  clearSearchEnv();
  resetFetchCalls();
  await assert.rejects(
    () => searchWithProvider("anything"),
    /No live search provider configured/,
    "kernel must fail fast when no provider is set"
  );

  console.log("search provider tests ok");
} catch (error) {
  console.error("search provider tests failed:", error);
  process.exit(1);
} finally {
  clearSearchEnv();
}
