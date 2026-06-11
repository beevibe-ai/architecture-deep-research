// Infer the REAL architecture from a repo scan.
//
// This is the heart of reality-binding: instead of the human drawing boxes, the
// model reads the actual repo digest (manifests, deploy configs, directory
// structure, observability libs) and emits the architecture the code actually
// implements — every component grounded in a real file (cite-or-die). The host
// runs this into a fresh seed spec via the normal assistant loop, then diffs the
// result against the canvas to surface drift.

// Condense a full repo scan into a compact, high-signal prompt. The scanner's
// digest is rich; we keep the parts that reveal components and trim verbose docs
// so a single inference call stays well within context.
export function digestForInference(scan) {
  const lines = [];
  lines.push(`Repo: ${scan.repo_path}`);
  if (scan.git_signals?.branch) lines.push(`Branch: ${scan.git_signals.branch}`);

  const dirs = (scan.tree || []).filter((t) => t.kind === "dir").map((t) => t.path);
  if (dirs.length) lines.push(`\nDirectory structure (modules/services live here):\n${dirs.slice(0, 60).map((d) => "  " + d).join("\n")}`);

  if (scan.manifests?.length) {
    lines.push(`\nPackage manifests (dependencies reveal tech — pg→Postgres, redis→cache, kafkajs→Kafka, @qdrant/*→vector store, openai/anthropic→LLM provider, express/fastify→service, next/react→client):`);
    for (const m of scan.manifests) {
      if (m.content === "[lockfile present]") continue;
      lines.push(`\n--- ${m.path} (${m.kind}) ---\n${trim(m.content, 1800)}`);
    }
  }

  if (scan.deploy_configs?.length) {
    lines.push(`\nDeploy configs (services, datastores, infra):`);
    for (const c of scan.deploy_configs) {
      lines.push(`\n--- ${c.path} (${c.platform}) ---\n${trim(c.content, 1200)}`);
    }
  }

  if (scan.observability_signals?.length) {
    lines.push(`\nObservability libraries detected: ${scan.observability_signals.map((o) => `${o.name} (${o.evidence_cite.join(", ")})`).join("; ")}`);
  }

  const archDoc = (scan.docs || []).find((d) => /ARCHITECTURE|DESIGN/i.test(d.path)) || (scan.docs || []).find((d) => /README/i.test(d.path));
  if (archDoc) lines.push(`\nArchitecture intent from ${archDoc.path}:\n${trim(archDoc.content, 1500)}`);

  return lines.join("\n");
}

function trim(s, max) {
  const str = String(s || "");
  return str.length <= max ? str : str.slice(0, max) + "\n[…truncated]";
}

// The instruction handed to the assistant. It must build ONLY the architecture
// view, only from evidenced components, and cite the grounding file in `notes`
// so drift can show where each claim came from.
export function inferenceInstruction(digest) {
  return [
    "You are reverse-engineering the architecture of a REAL codebase from its repo digest below.",
    "Reconstruct the system's actual architecture as it exists in the code — not an ideal design.",
    "",
    "Rules:",
    "- Add ONLY components you can ground in the digest (a dependency, a deploy service, a directory, a doc). Cite-or-die: do not invent components the evidence doesn't support.",
    "- For every component, put the grounding file path(s) in `notes` (e.g. notes: \"package.json, docker-compose.yml\"). This is the evidence drift will show.",
    "- Set `tech` to the concrete technology the code uses (pgvector, Kafka, Redis, Postgres, …) when the evidence names it.",
    "- Build on the architecture view only, using arch_add_node and arch_connect. Wire components by how they actually call each other. Keep it to the real top-level components, not every file.",
    "- Run auto_layout on architecture when done.",
    "- Then reply with one sentence: how many components you found and the overall shape.",
    "",
    "Repo digest:",
    digest,
  ].join("\n");
}
