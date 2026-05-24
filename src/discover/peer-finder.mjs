// Peer finder.
//
// Real users picking architectures don't reason in the abstract — they look
// at 3-5 already-shipped products in the same space and ask "what did they
// do, and does it apply to us?" This module powers the --include-peers
// opt-in on `adr discover`. When set, it produces peers.json which the
// deep-research stage picks up and turns into one targeted research task
// per peer for the specific decision aspect (vector store, queue, auth, ...).
//
// Two-step pipeline:
//   1. LLM call enumerates 5-12 named peers given the PRD + decision +
//      optional seed product. Each peer gets name, label, github_url (when
//      open-source), why_comparable.
//   2. For peers with a github_url, fetch GitHub signal (stars, last commit,
//      contributors) and rank. Drop dead repos (no commits in 18 months).
//      Cap at max_peers (default 5).

import { callLlmJson, githubApi, nowIso, parseGithubRepoUrl, VERSION } from "../kernel.mjs";

const DEFAULT_MAX_PEERS = 5;
const STALE_REPO_AFTER_DAYS = 18 * 30;
const EVIDENCE_STRATEGIES = new Set(["architecture", "adoption", "both"]);
const DEFAULT_EVIDENCE_STRATEGY = "architecture";

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

async function enumeratePeers({ decision, domain, decisionKind, seed, prd, issueBody, repoDigest, maxPeers }) {
  const raw = await callLlmJson({
    label: "discover_peer_finder",
    system: [
      "You are the peer-product finder for Architecture Deep Research.",
      "",
      `Decision being made: "${decision}" (kind: ${decisionKind || "family"}).`,
      `Domain: "${domain}".`,
      seed ? `Seed product (the user's own): "${seed}".` : "",
      "",
      "Real users picking an architecture look at 3-5 already-shipped similar",
      "products and reason \"what did they do, and does it apply to us?\".",
      "Your job is to name those similar products so the deep-research stage",
      "can deep-read each one's repo + docs to extract evidence on this",
      "specific decision aspect.",
      "",
      "Output 5-12 named peers. For each:",
      "  name              — kebab-case slug (e.g., 'cal-com', 'linear', 'penpot')",
      "  label             — display name as users know it (e.g., 'Cal.com')",
      "  github_url        — canonical GitHub repo URL when open-source.",
      "                      Use empty string when closed-source (Notion, Linear).",
      "                      DO NOT guess GitHub URLs — only include URLs you're",
      "                      confident exist.",
      "  homepage_url      — product homepage when known",
      "  docs_url          — docs root when known",
      "  engineering_blog_url — engineering blog root when known",
      "  why_comparable    — one sentence; specifically WHY this peer is",
      "                      comparable for THIS decision, not generic similarity",
      "  evidence_strategy — one of: \"architecture\" | \"adoption\" | \"both\".",
      "                      Pick based on observable signals:",
      "                        architecture — peer has a public github repo with",
      "                          active commits AND an engineering blog OR public",
      "                          architecture docs. Examples: Neo4j, Memgraph,",
      "                          ArangoDB, Weaviate.",
      "                        adoption — peer is closed-source or has no public",
      "                          architecture-revealing docs, but has substantial",
      "                          community adoption (large user base, vibrant",
      "                          subreddit, frequent HN appearances). Examples:",
      "                          Obsidian, Roam Research, Mem.ai, Notion.",
      "                        both — peer has both: open core / public source AND",
      "                          large adoption community. Examples: Logseq,",
      "                          Supabase.",
      "",
      "Be precise:",
      "- For a vector-store decision in an agent OS, peers are agent OSes /",
      "  similar agent runtimes (Onyx, AnythingLLM, Open WebUI, danswer-ai)",
      "  NOT generic SaaS products.",
      "- For an auth-provider decision in a multi-tenant SaaS, peers are",
      "  similar multi-tenant SaaS products that ship auth (Cal.com, Penpot,",
      "  Plane, Documenso, NocoDB) — NOT auth library vendors themselves.",
      "- Bias toward products at similar maturity/scale to the seed. A solo",
      "  founder seed should look at startup-scale peers, not Salesforce.",
      "- Closed-source / adoption-strategy peers are explicitly welcome. They",
      "  carry real signal (community size, plugin ecosystem, \"we tried X\"",
      "  threads) even when their architecture isn't publicly documented.",
      "",
      `Cap at ${maxPeers ?? DEFAULT_MAX_PEERS * 2} peers total (we'll rank + trim).`,
      "Do not invent products. Do not include products you only think exist.",
      "",
      "Output JSON: { peers: [{ name, label, github_url, homepage_url, docs_url, engineering_blog_url, why_comparable, evidence_strategy }] }."
    ]
      .filter(Boolean)
      .join("\n"),
    user: JSON.stringify({
      decision,
      domain,
      decision_kind: decisionKind || "family",
      seed: seed || null,
      issue_body: issueBody || null,
      prd_content: typeof prd === "string" ? prd.slice(0, 20_000) : null,
      repo_digest: repoDigest
        ? {
            top_level: repoDigest.top_level,
            docs: (repoDigest.docs || []).slice(0, 6).map((d) => ({ path: d.path, kind: d.kind })),
            manifests: (repoDigest.manifests || []).slice(0, 6).map((m) => ({ path: m.path }))
          }
        : null
    })
  });

  return toArray(raw.peers)
    .filter((p) => p && typeof p === "object" && typeof p.label === "string" && p.label.trim())
    .map((p) => {
      const name = slugify(String(p.name || p.label || "").trim());
      const rawStrategy =
        typeof p.evidence_strategy === "string" ? p.evidence_strategy.trim().toLowerCase() : "";
      const evidence_strategy = EVIDENCE_STRATEGIES.has(rawStrategy)
        ? rawStrategy
        : DEFAULT_EVIDENCE_STRATEGY;
      return {
        name: name || slugify(p.label),
        label: String(p.label).trim(),
        github_url: typeof p.github_url === "string" ? p.github_url.trim() : "",
        homepage_url: typeof p.homepage_url === "string" ? p.homepage_url.trim() : "",
        docs_url: typeof p.docs_url === "string" ? p.docs_url.trim() : "",
        engineering_blog_url:
          typeof p.engineering_blog_url === "string" ? p.engineering_blog_url.trim() : "",
        why_comparable: typeof p.why_comparable === "string" ? p.why_comparable.trim() : "",
        evidence_strategy
      };
    })
    .filter((p) => p.name && p.label);
}

// Fetch GitHub signal for a peer when a github_url is supplied. Returns null
// when the URL is malformed, the API errored, or the response was empty.
// Failures are silent — peers without signal stay in the pool with empty
// signal: {} so the ranker can still use them (just at lower confidence).
async function fetchPeerSignal(githubUrl, flags = {}) {
  const parsed = parseGithubRepoUrl(githubUrl);
  if (!parsed) return null;
  try {
    const repo = await githubApi(`/repos/${parsed.owner}/${parsed.repo}`, flags);
    if (!repo || typeof repo !== "object") return null;
    const signal = {
      stars: Number(repo.stargazers_count) || 0,
      open_issue_count: Number(repo.open_issues_count) || 0,
      primary_language: String(repo.language || "").trim() || "unknown",
      last_commit_at: repo.pushed_at || repo.updated_at || null,
      first_commit_at: repo.created_at || null
    };
    return signal;
  } catch {
    return null;
  }
}

function isStaleRepo(signal) {
  if (!signal || !signal.last_commit_at) return false;
  const last = Date.parse(signal.last_commit_at);
  if (!Number.isFinite(last)) return false;
  const ageDays = (Date.now() - last) / (1000 * 60 * 60 * 24);
  return ageDays > STALE_REPO_AFTER_DAYS;
}

function rankPeers(peers, maxPeers) {
  // Score: stars (log-scaled) + recency bonus. The closed-source penalty
  // only applies to architecture-strategy peers — for adoption / both peers
  // (Obsidian, Roam, Mem.ai) being closed-source is *why* they're adoption-
  // strategy, and the adoption signal substitutes for source-code evidence.
  const scored = peers.map((peer) => {
    const stars = peer.signal?.stars || 0;
    const last = peer.signal?.last_commit_at ? Date.parse(peer.signal.last_commit_at) : 0;
    const ageDays = last ? (Date.now() - last) / (1000 * 60 * 60 * 24) : 365 * 5;
    const recencyBonus = Math.max(0, 1 - ageDays / (365 * 2)); // 1.0 at fresh, 0 at 2y old
    const starsScore = Math.log10((stars || 1) + 1);
    const strategy = String(peer.evidence_strategy || "architecture").toLowerCase();
    const closedSourcePenalty = peer.github_url || strategy !== "architecture" ? 0 : -0.5;
    return {
      ...peer,
      _rank_score: Number((starsScore + recencyBonus + closedSourcePenalty).toFixed(3))
    };
  });
  return scored
    .sort((a, b) => b._rank_score - a._rank_score)
    .slice(0, maxPeers)
    .map(({ _rank_score, ...rest }) => rest);
}

// Public entry: produce peers.json content. Caller writes it to disk.
async function findPeers({
  decision,
  domain,
  decisionKind,
  seed,
  prd,
  issueBody,
  repoDigest,
  flags = {},
  maxPeers = DEFAULT_MAX_PEERS
}) {
  const enumerated = await enumeratePeers({
    decision,
    domain,
    decisionKind,
    seed,
    prd,
    issueBody,
    repoDigest,
    maxPeers
  });

  // Fetch GitHub signal in parallel. Failures are silent. Peers without a
  // resolved signal get the field omitted entirely — the schema requires
  // signal to be an object when present (closed-source peers and fetch
  // failures both produce no signal).
  const enriched = await Promise.all(
    enumerated.map(async (peer) => {
      if (!peer.github_url) return peer;
      const signal = await fetchPeerSignal(peer.github_url, flags);
      return signal ? { ...peer, signal } : peer;
    })
  );

  // Drop stale repos (no commits in 18 months) — they're not active peers.
  const alive = enriched.filter((peer) => {
    if (!peer.github_url) return true; // keep closed-source
    if (!peer.signal) return true; // keep when signal fetch failed (give benefit of doubt)
    return !isStaleRepo(peer.signal);
  });

  const ranked = rankPeers(alive, maxPeers);

  // Schema requires seed to be a string when present, not null. Omit the
  // field when no seed was supplied rather than writing `seed: null`.
  const artifact = {
    version: VERSION,
    decision,
    domain,
    extracted_at: nowIso(),
    peers: ranked
  };
  if (typeof seed === "string" && seed.trim()) {
    artifact.seed = seed.trim();
  }
  return artifact;
}

export { findPeers, enumeratePeers, fetchPeerSignal, rankPeers, DEFAULT_MAX_PEERS };
