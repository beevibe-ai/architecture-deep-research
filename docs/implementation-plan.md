# Implementation Plan

This plan turns Architecture Deep Research from a manifesto into a small working product loop without changing the product boundary.

ADR stops at **Execution Handoff**. Downstream coding agents may consume the handoff, but implementation remains outside the ADR core.

## Milestone A: Framework-Neutral Kernel

Implement a dependency-light core that can:

- Read a product brief or PRD.
- Normalize it into a Strategic Context Model.
- Compare candidate architecture families.
- Emit ADR artifacts.
- Emit an execution handoff for downstream agents.

Initial artifacts:

```text
strategic-context.json
ADR.md
architecture.spec.json
domain-evaluation-pack.json
agent-guardrails.md
execution-handoff.json
sources.md
```

## Milestone B: Strategic Context Model

The Strategic Context Model is the intermediate object between raw product language and architecture selection.

It should capture:

- Domain entities.
- Bounded contexts.
- Query shapes.
- Risk invariants.
- Operational envelope.
- Compliance constraints.
- Candidate architecture families.

The first implementation uses deterministic heuristics and explicit user-supplied metadata. Later implementations can replace extraction with a reviewed LLM pipeline while keeping the same schema.

## Milestone C: Precedent Mining Protocol

The first version should not scrape the web automatically. It should emit a research plan and source targets that a Beevibe Architect, LangGraph adapter, or ADK adapter can execute.

Precedence vectors:

- Official framework docs.
- Production engineering writeups.
- Mature open-source repositories.
- Architecture benchmarks and papers.
- Failure-mode reports and migration stories.

## Milestone D: Constraint And Evaluation Generation

Generate architecture constraints and evaluation packs from the Strategic Context Model.

The generator must:

- Preserve rejected alternatives.
- Explain why the selected topology fits.
- Produce adversarial domain questions.
- Include abstention and lineage checks.
- Keep all generated outputs schema-valid.

## Milestone E: Execution Handoff

The final product output is not implementation. It is a handoff package:

- Workspace guardrails.
- Beevibe task context.
- Tool-specific adapter targets.
- Required invariants.
- Evaluation pack references.

Implementation tools consume the package, then return drift/evaluation evidence that can trigger a superseding ADR.

## Initial Slice

The first implemented slice is a local CLI:

```bash
npm run adr -- research examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out /tmp/adr-output
```

This is not the final deep research engine. It is the stable artifact kernel that orchestration adapters can call.
