# Implementation Plan

This plan turns Architecture Deep Research from a manifesto into a small working product loop without changing the product boundary.

ADR stops at **Execution Handoff**. Downstream coding agents may consume the handoff, but implementation remains outside the ADR core.

## Milestone A: Framework-Neutral Kernel

Implement a dependency-light core that can:

- Read a product brief or PRD.
- Normalize it into a Strategic Context Model.
- Acquire candidate architecture families from live evidence.
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
- Acquisition contract for candidate architecture families.

The Strategic Context Model may use lightweight extraction to describe the PRD, but architecture-family knowledge is not static. Candidate families are acquired by live research, claim extraction, and evidence promotion.

## Milestone C: Precedent Mining Protocol

The research engine must use live source acquisition. It emits a plan, executes source searches, opens sources, extracts claims, and promotes only evidence-backed candidates.

Precedence vectors:

- Official framework docs.
- Production engineering writeups.
- Mature open-source repositories.
- Architecture benchmarks and papers.
- Failure-mode reports and migration stories.

## Milestone D: Constraint And Evaluation Generation

Generate architecture constraints and evaluation packs from the Strategic Context Model plus the evidence-only knowledge map.

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

The implemented slice is a live agentic CLI:

```bash
npm run adr -- deep-research examples/logistics-contract-mesh/product-context.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out /tmp/adr-output
```

The CLI requires live search and an OpenAI-compatible LLM provider. It is the stable artifact kernel that orchestration adapters can call.
