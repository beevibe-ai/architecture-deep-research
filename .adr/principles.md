# Team principles

Discovered by `adr principles init` on 2026-05-26T01:02:37.360Z. 8 lenses, 11 principles.

Run `adr review <PR#>` (or `adr review --staged`) to check a change against this list. Run `adr principles init` again to refresh.

## Lenses

- **LLM call discipline** (`llm-call-discipline`) — All LLM calls must go through a single helper function or provider abstraction to ensure consistent prompt formatting, error handling, and JSON parsing.
- **Schema validate before write** (`schema-validate-before-write`) — Every persisted artifact (e.g., research-report.json, comparison-matrix.json) must be validated against its JSON schema before writing to disk to prevent corrupt or invalid data.
- **Event stream shape** (`event-stream-shape`) — Events appended to events.jsonl must follow a consistent shape and include necessary metadata like timestamps and event types for reliable auditing and replay.
- **CLI subcommand pattern** (`cli-subcommand-pattern`) — New CLI subcommands must attach in a consistent pattern in scripts/adr.mjs with clear parsing of positional arguments and flags.
- **Test fixture discipline** (`test-fixture-discipline`) — Regression tests must mock LLM responses and external dependencies deterministically to ensure hermetic and reproducible test runs.
- **State boundaries** (`state-boundaries`) — Component-local state and global store state must be clearly separated, especially in the web UI and agent runtime, to avoid unintended side effects.
- **Error handling posture** (`error-handling-posture`) — The codebase must consistently use either Result types or exceptions for error handling, avoiding silent failures or inconsistent patterns.
- **Artifact boundary enforcement** (`artifact-boundary-enforcement`) — The ADR pipeline must enforce clear boundaries where the process stops (e.g., at execution handoff) and downstream agents consume artifacts, preventing leakage of internal state.

## Principles

### Schema validate before write

#### DO: Validate every persisted JSON artifact against its corresponding JSON schema before writing it to disk to prevent corrupt or invalid data. _(medium confidence, inferred)_

Ensuring all persisted artifacts conform to their JSON schemas maintains data integrity and prevents runtime errors caused by malformed data.

**Team example to follow:**
- `adapters/beevibe.mjs:53`
- `adapters/beevibe.mjs:56`
- `adapters/beevibe.mjs:59`
- `src/kernel.mjs:79`
- `src/principles/index.mjs:31`
- `src/discover/index.mjs:31`

_Evidence: `docs/schemas`, `src/kernel.mjs:9`, `src/kernel.mjs:79`, `src/principles/index.mjs:31`, `src/discover/index.mjs:31`, `scripts/check-json.mjs`, `src/guard/index.mjs:7`, `src/guard/index.mjs:18`, `adapters/beevibe.mjs:53`, `adapters/beevibe.mjs:56`, `adapters/beevibe.mjs:59`_

#### DO: The scripts/check-json.mjs script must be run as part of CI or pre-commit hooks to validate JSON artifacts against their schemas before accepting changes.

Running schema validation in CI ensures that invalid JSON artifacts are caught early and never merged.

**Team example to follow:**
- `scripts/check-json.mjs`

_Evidence: `scripts/check-json.mjs`_

### CLI subcommand pattern

#### DO: All CLI subcommands must be attached as subcommands in the main scripts/adr.mjs file, which parses the first positional argument as the subcommand, subsequent arguments as flags (parsed as --key value or --flag boolean), supports multiple values per flag, and provides explicit usage and help messages.

Consistent CLI subcommand parsing and usage messages ensure predictable and user-friendly command line interface.

**Team example to follow:**
- `scripts/adr.mjs:10-110`

_Evidence: `scripts/adr.mjs:10-110`_

#### DO: Before running any CLI subcommand, environment variables must be loaded from a config file to ensure required keys are set and consistent runtime configuration.

Hydrating environment config before command execution prevents runtime errors due to missing configuration.

**Team example to follow:**
- `scripts/adr.mjs:20-30`
- `scripts/adr-doctor.mjs:1-120`

_Evidence: `scripts/adr.mjs:20-30`, `scripts/adr-doctor.mjs`_

### Test fixture discipline

#### DO: Regression tests must mock LLM responses and external dependencies deterministically by installing fixture providers and stubbing global fetch and environment variables, ensuring no network calls occur in local test suites.

Mocking external dependencies ensures hermetic, reproducible, and stable test runs.

**Team example to follow:**
- `scripts/kernel-regression-tests.mjs:11-38`
- `scripts/search-provider-tests.mjs:5-90`

_Evidence: `scripts/kernel-regression-tests.mjs:11-38`, `scripts/search-provider-tests.mjs:5-90`_

### State boundaries

#### DO: Component-local UI state must be managed with React useState hooks for form inputs, while global runtime state and configuration such as domain, decision, outDir, and runtime flags must be passed explicitly as props or parameters and managed centrally in kernel or environment config, not mixed with UI local state.

Clear separation of local UI state and global runtime state prevents unintended side effects and improves maintainability.

**Team example to follow:**
- `web/src/views/NewRunForm.jsx:1-80`
- `src/kernel.mjs:1-200`

_Evidence: `web/src/views/NewRunForm.jsx:1-100`, `src/kernel.mjs:1-200`, `scripts/adr-doctor.mjs:1-100`, `scripts/adr-mcp.mjs:1-100`_

#### DO: Application navigation state must be managed by react-router-dom in web/src/App.jsx, not mixed with business or runtime state.

Separating routing state from business state improves clarity and reduces coupling.

**Team example to follow:**
- `web/src/App.jsx:1-50`

_Evidence: `web/src/App.jsx:1-50`_

#### DO: Long-lived state such as research reports and execution handoff artifacts must be written to disk in dedicated output directories, not stored in UI or runtime memory.

Persisting artifacts to disk enforces clear state boundaries and enables downstream consumption.

**Team example to follow:**
- `adapters/beevibe.mjs:1-100`

_Evidence: `adapters/beevibe.mjs:1-100`, `src/discover/index.mjs:1-100`_

### Artifact boundary enforcement

#### DO: The ADR pipeline must enforce clear artifact boundaries by declaring output artifacts explicitly in agent runtime_config, producing execution-handoff.json as the pipeline boundary, storing artifacts in dedicated output directories per run, and ensuring downstream agents consume only structured JSON artifacts, not internal runtime state.

Clear artifact boundaries prevent leakage of internal state and enforce a clean contract between pipeline stages.

**Team example to follow:**
- `adapters/beevibe.mjs:10-90`

_Evidence: `adapters/beevibe.mjs:10-38`, `adapters/google-adk.mjs:40-55`, `adapters/beevibe.mjs:40-70`, `web/src/App.jsx:40-45`, `src/discover/index.mjs:40-80`, `scripts/adr.mjs:70-110`, `adapters/beevibe.mjs:50-90`, `src/discover/discovered-evidence.mjs:10-80`_

#### DO: LLM providers used in the ADR pipeline must be configured to produce only single JSON objects without markdown fences or prose, ensuring artifact integrity and boundary enforcement.

Strict JSON-only output prevents accidental leakage of internal state or extraneous information beyond the defined artifact schema.

**Team example to follow:**
- `adapters/langgraph-llm.mjs:10-80`

_Evidence: `adapters/langgraph-llm.mjs:10-80`, `adapters/google-adk-deep-research.mjs:10-80`_

#### DO: Before running ADR commands or MCP server, environment variables must be hydrated from a config file (~/.adr/config.json) to ensure consistent runtime configuration and prevent leakage of secrets or internal state.

Hydrating environment config enforces a well-defined runtime boundary and prevents accidental leakage.

**Team example to follow:**
- `scripts/adr-doctor.mjs:1-120`

_Evidence: `scripts/adr-doctor.mjs:1-120`, `scripts/adr-mcp.mjs:1-80`, `scripts/adr.mjs:20-50`_
