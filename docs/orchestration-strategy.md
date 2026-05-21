# Orchestration Strategy

Architecture Deep Research must support long-running investigation, isolated specialist work, human review, and deterministic artifacts. That makes the orchestration layer important, but it should not become the product's domain model.

The core decision is:

> ADR owns the research state, artifact schemas, bounded-context model, and evaluation contracts. Frameworks are adapters.

## Why Not Bet The Core On One Framework?

LangGraph and Google ADK are both strong orchestration systems, but ADR needs to stay useful in several deployment modes:

- Self-hosted Beevibe workspaces.
- Local developer machines.
- Open-source microservice backends.
- Google Cloud and Gemini Enterprise environments.
- Future agent runtimes that do not exist yet.

If ADR bakes one orchestration framework into the core, the strategic architecture layer becomes coupled to framework release cycles and provider-specific assumptions. The safer architecture is a small deterministic core with thin orchestration adapters.

## Proposed Topology

```text
                         Beevibe Workspace
                               |
                               v
                  +--------------------------+
                  |  ADR Research Request    |
                  +------------+-------------+
                               |
                               v
                  +--------------------------+
                  |  Framework-Neutral Core  |
                  |  - research state        |
                  |  - bounded contexts      |
                  |  - evidence model        |
                  |  - artifact schemas      |
                  |  - evaluation contracts  |
                  +------------+-------------+
                               |
             +-----------------+-----------------+
             |                 |                 |
             v                 v                 v
      Beevibe Native      LangGraph Adapter   Google ADK Adapter
      - agent mesh        - cyclic graphs     - enterprise runtime
      - memory            - checkpointers     - graph workflows
      - hierarchy         - interrupts        - sessions/memory
      - review policy     - subgraphs         - governance
```

## Core ADR Kernel

The ADR kernel should be dependency-light and deterministic. Its job is to define what a valid research run means, independent of who orchestrates the sub-agents.

Core responsibilities:

- Define `ResearchRun`, `ResearchQuestion`, `EvidenceItem`, `CandidateTopology`, `DecisionRecord`, `ArchitectureSpec`, and `DomainEvaluationPack`.
- Validate artifacts with JSON Schema and, in Python implementations, Pydantic models.
- Preserve bounded-context boundaries and domain invariants.
- Maintain an append-only event log for research steps, evidence, rejections, human approvals, and final artifacts.
- Emit machine-readable specs that Beevibe agents and external coding agents can consume.

Non-responsibilities:

- Owning web search providers.
- Owning model providers.
- Owning cloud deployment.
- Owning all agent runtime semantics.

## Adapter Contract

Each orchestration adapter should implement the same conceptual contract:

```text
start_research_run(input_context) -> research_run_id
run_discovery_step(research_run_id, question) -> evidence_items
run_critic_step(research_run_id, candidate_topology) -> critique
request_human_review(research_run_id, artifact) -> approval_result
emit_artifacts(research_run_id) -> ADR.md + architecture.spec.json + domain-evaluation-pack.json
```

Adapters may use different runtimes, but they must not bypass core validation.

## Beevibe Native Adapter

Beevibe is the natural product runtime for ADR because it already has the required primitives:

- An Architect specialist can be represented as a normal Agent with `hierarchy_level`, `parent_agent_id`, `runtime_config`, and `review_policy`.
- Durable architecture knowledge can live in bounded domain memory and pgvector-backed fact storage.
- IC coding agents can ask the Architect through the mesh when they reach an architecture boundary.
- Team and org hierarchy can route architecture decisions downward into execution handoff tasks.
- Human review can be enforced with the existing review policy.
- Self-hosted deployment keeps architecture context inside the user's own workspace.

The Beevibe adapter should be the product-default path.

## LangGraph Adapter

LangGraph is a good fit for open-source cyclic research flows.

Use it when:

- The run needs explicit loops between discovery, critique, rejection, and re-query.
- The deployment wants Python or TypeScript graph workflows.
- Human-in-the-loop checkpoints are important.
- A research branch should pause and resume with persisted state.

Useful LangGraph concepts:

- `StateGraph` for explicit graph state and reducers.
- Nodes and conditional edges for discovery, critique, synthesis, and review stages.
- Checkpointers for durable execution.
- `interrupt()` and compile-time breakpoints for human approval and debugging.
- Subgraphs for isolated specialist flows.

ADR should use LangGraph for orchestration only. The architecture spec, DDD boundaries, and evaluation pack still belong to the ADR kernel.

## Google ADK Adapter

Google ADK is a strong enterprise adapter, especially for teams already using Google Cloud or Gemini Enterprise.

Use it when:

- The customer wants Google-managed agent runtime infrastructure.
- The workflow benefits from ADK graph-based workflows, dynamic workflows, or deterministic workflow agents.
- The organization needs managed sessions, memory, tracing, evaluation, sandbox execution, IAM, gateways, or enterprise governance.
- Specialist agents should be exposed as tools inside a larger hierarchical agent system.

Useful ADK concepts:

- Graph-based workflows for structured execution paths.
- Workflow agents for deterministic sequential, parallel, and loop patterns.
- Multi-agent systems and agent-as-tool composition.
- Agent Platform Runtime, Sessions, Memory Bank, evaluation, and observability in Google Cloud.

ADR should not assume Gemini-only execution. The ADK adapter must preserve the same artifact contracts as every other adapter.

## Custom Graph Code

Custom graph code is acceptable for the first narrow product loop when it keeps the core simpler.

Use it when:

- The task is mostly schema validation and artifact generation.
- The runtime is Beevibe-native and already has sessions, review, hierarchy, and memory.
- A framework would introduce more abstraction than the current milestone needs.

Custom orchestration should still follow the adapter contract so the runtime can later be swapped for LangGraph or ADK.

## Framework Selection Matrix

| Requirement | Beevibe Native | LangGraph | Google ADK | Custom Core |
| --- | --- | --- | --- | --- |
| Beevibe product fit | Excellent | Adapter only | Adapter only | Good |
| DDD boundary ownership | Excellent | Good if modeled in state schemas | Good if modeled in tools/workflows | Excellent |
| Cyclic discovery loops | Good | Excellent | Excellent in ADK 2.0 graph workflows | Manual |
| Human review | Excellent via `review_policy` | Excellent via interrupts/checkpoints | Good via platform/workflow controls | Manual |
| Enterprise managed runtime | Self-hosted | Via deployment target | Excellent | Manual |
| Model/provider neutrality | Excellent | Good | Good, but Google-first | Excellent |
| Artifact determinism | Excellent if kernel-owned | Good if kernel-owned | Good if kernel-owned | Excellent |

## Decision

ADR should use a **framework-neutral core with orchestration adapters**.

Initial priority:

1. Beevibe-native adapter, because it validates ADR as a full Beevibe product.
2. Minimal custom orchestration for the first CLI and artifact-generation loop.
3. LangGraph adapter for open-source cyclic research workflows.
4. Google ADK adapter for Google Cloud and enterprise deployments.

This keeps the product centered on strategic architecture research rather than any one agent framework.

## Sources

- LangGraph Graph API: https://docs.langchain.com/oss/python/langgraph/graph-api
- LangGraph durable execution: https://docs.langchain.com/oss/python/langgraph/durable-execution
- LangGraph interrupts: https://docs.langchain.com/oss/python/langgraph/interrupts
- Google ADK: https://adk.dev/
- Google ADK workflows: https://adk.dev/workflows/
- Google ADK workflow agents: https://adk.dev/agents/workflow-agents/
- Gemini Enterprise Agent Platform: https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale
