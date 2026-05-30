# Self-discover example

This example runs the `adr discover` stage against the beevibe-cto repo itself. It is the simplest way to see what the new discover stage produces.

## Why this exists

The biggest barrier to running ADR is not the CLI — it is the PRD-writing step. People know they have an architecture question; they do not have a structured product brief sitting around.

`adr discover` removes that step. It scans the user's own repo for patterns and anti-patterns, extracts stack and compliance constraints, and drafts a `pdr.draft.md` the user reviews. The user then runs `adr deep-research` on the draft.

This example is the "dogfooding" version: discover scanning the ADR repo itself, so you can see what the output looks like on a real codebase before pointing it at your own.

## Requirements

- A configured LLM provider (the same one you would use for `deep-research`):
  - `ADR_OPENAI_API_KEY` or `OPENAI_API_KEY` for the OpenAI-compatible runtime, or
  - any LangChain-supported provider when running through the LangGraph CLI

No web-search provider is needed — discover does not hit the internet.

## Run it

From the root of the beevibe-cto repo:

```bash
npm run adr -- discover \
  --repo . \
  --decision "retrieval topology" \
  --out .adr-runs/self-discover
```

A typical run takes 15–45 seconds and costs less than one cent on `gpt-4.1-mini`.

## What gets produced

```
.adr-runs/self-discover/
├── events.jsonl                 the six discover events, in order
├── discovered-principles.json   patterns the team already follows + anti-patterns rejected
├── discovered-constraints.json  stack, deploy target, compliance signals, team-size hint
└── pdr.draft.md                 the draft PRD, with an Open questions section to fill in
```

## Chaining into deep-research

Open `pdr.draft.md`, fill in the Open questions section, and run:

```bash
npm run adr -- deep-research .adr-runs/self-discover/pdr.draft.md \
  --domain "global logistics contract analysis" \
  --decision "retrieval topology" \
  --out .adr-runs/self-discover-deep
```

## Plugging into a GitHub-issue bot

`--issue-body` accepts either a path to a file or a literal string. A bot listening for `/adr` comments can pass the issue body directly:

```bash
adr discover \
  --repo /workspace/repo \
  --decision "$DECISION_FROM_LABEL" \
  --issue-body "$ISSUE_BODY" \
  --out /workspace/adr-run
```

The draft PRD that comes out is what the bot posts back to the issue for the user to review.
