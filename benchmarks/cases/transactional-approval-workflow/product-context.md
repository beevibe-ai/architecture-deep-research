# Benchmark Case: Transactional Approval Workflow

We are building an enterprise approval workflow for account provisioning and access changes.

The system owns source-of-truth state for users, accounts, approvals, policies, tasks, and audit events. The core operations are commands and mutations: request access, approve access, deny access, revoke access, and record an immutable audit event.

Representative workflows:

- A manager approves a user access request.
- A policy rule blocks a risky account mutation.
- An auditor reviews the sequence of approval events.
- A task transitions from requested to approved to fulfilled.

Important constraints:

- Aggregate ownership and transactional consistency matter.
- State mutation must be explicit and reviewable.
- The domain is not primarily a RAG or GraphRAG question-answering problem.
- Retrieval may help users inspect policy docs, but it must not own source-of-truth workflow state.
- Bounded contexts should separate access requests, policy decisions, audit events, and task execution.
