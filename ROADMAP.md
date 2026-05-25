# Roadmap

The AI CTO loop is shipped end-to-end:

```
adr decide  →  adr principles init  →  adr review  →  adr guard
```

This file tracks what's next. Items are listed in user-impact order, not implementation order — though they're broadly aligned.

## Why principles must evolve

The most common failure mode of code-quality tooling is static linting: write the config once, never update it, watch it drift from real team practice, end up with a wall of `// disable` comments and a tool nobody trusts.

`.adr/principles.json` faces the same risk if we treat it as a one-shot artifact. Three mechanisms keep it from going stale:

- **Decay detection** — automatic signals when principles point at code that no longer exists or new patterns the file hasn't caught up to.
- **Feedback loops** — every `adr review` run produces accept/edit/skip signals per principle. Skipped principles fade; accepted principles harden. The rules learn from how the team actually uses them.
- **Incremental discovery** — pick up new patterns as the codebase grows, without re-running the full ~3-minute discovery from scratch.

Half the roadmap below is dedicated to these.

---

## Priority list

### Evolvability — preventing the static-lint trap

#### 1. Cite-rot check + `health` block in principles.json

Every `adr review` runs a cheap (no-LLM) verification of every principle's `evidence_cite` and `examples_to_follow`. Citations pointing at files that no longer exist on disk get flagged. Output gains a `health` block (`stale_count`, `total`, `last_checked`, `stale_principles`). When >25% of a principle's citations are stale, the review surfaces "your principles are drifting — run `adr principles refresh`".

_Why first: the cheapest evolvability signal, and the bot starts citing nonexistent files within weeks of a refactor without it._

_Size: ~half day._

#### 2. `adr principles refresh` — incremental refresh

Today, re-running `adr principles init` blows away the interview log. The refresh flow scans the repo, diffs the discovered patterns against the existing `principles.json`, and only asks about *new* ambiguities or principles whose evidence has rotted. Preserves confirmed answers.

_Why second: without this, "evolve the principles" is too expensive for teams to actually do._

_Size: ~1 day._

#### 3. Accept/edit/skip stats persisted per principle

Every `adr review` walkthrough produces signals. Today we throw them away. Persist into `.adr/principle-stats.json`, keyed by principle id. Tracks accepts, edits, skips over time.

_Why: prerequisite for #5 (confidence auto-evolves) and #7 (refine)._

_Size: ~half day._

#### 4. Suppression syntax `// adr-ignore: <principle-id>`

If a reviewer accepts an intentional violation on a specific line, the next PR-time check will flag it again. Need an inline-comment suppression convention the violation detector skips. Multiple principles per comment: `// adr-ignore: schema-validate-before-write, state-via-zustand-stores`.

_Why: without this, `adr review` becomes nagware after the first month._

_Size: ~half day._

#### 5. Confidence auto-evolves from review feedback

Using the stats from #3:
- Principle with **skip rate >50% over 5+ violations** → demoted to `confidence: low`, flagged in next refresh as "re-confirm or remove"
- Principle with consistent **accepts** → climbs `confidence: high` automatically, no interview needed

_Why: this is the killer feature versus static lint — principles learn from how they're used._

_Size: ~half day._

#### 6. `adr principles incremental` — runs on changed files since last refresh

Lightweight version of `adr principles init` that runs the per-lens extractor only over files changed since `last_refreshed`. Catches new patterns the team adopted three months ago without re-running the full discovery.

_Why: catches the "team adopted a new convention and nobody updated the principles file" failure._

_Size: ~1 day. Wires nicely as a post-merge git hook or nightly CI run._

#### 7. `adr principles refine <id>` — single-principle re-discovery

When `adr review` flags that a principle has high edit-rate (message is wrong but rule is right), or high skip-rate (rule may be wrong), this command re-runs discovery scoped to that one principle. Faster than a full refresh, more targeted.

_Size: ~half day._

### Phase 1 quality polish

#### 8. Exact-line cites, antipattern push, confidence grading

From the v0.2 self-test:
- Citations are line *ranges* (`scripts/adr.mjs:10-110`) — push for the specific line where the pattern is most visible
- Confidence is uniformly "high" — consolidator's grading prompt isn't being respected, sharpen or post-process
- Few/no antipatterns surface unless the repo has explicit "Rejected alternatives" docs — extract harder from removed-deps git history, deprecated-suffix files, eslint disables

_Size: prompt-engineering iteration, ~half day._

### Coverage gaps

#### 9. `adr drift <out_dir>` — periodic full-repo scan vs principles

Different from `review` because it scans the *whole repo* at HEAD, not a diff. Useful for "how far has the codebase drifted from the conventions we discovered six months ago?". Mostly a wrapper around the violation detector applied to every file.

_Size: ~1 day._

#### 10. GitLab + Bitbucket posters for `adr review`

Today `adr review` only posts via `gh` CLI (GitHub-only). Add the equivalent flows for `glab` and `bb` CLIs.

_Size: ~1 day each, mostly independent._

#### 11. Batched CI review mode

Today `adr review --non-interactive` prints to stdout and (with `--post`) posts comments one-by-one. CI bots typically want a single batched PR review with all comments at once. Add `--batch` flag wrapping `gh pr review --comment`.

_Size: ~half day._

### Housekeeping

#### 12. `adr guard uninstall`

Once installed, you can manually edit `.claude/settings.local.json` + `.git/hooks/pre-commit`. Add a clean removal subcommand.

_Size: ~hour._

#### 13. Diff-loader / gh-poster test coverage

No tests for diff-loader edge cases (renames, binary files, deletions). No tests for `gh-poster` since it shells out — needs a mock or contract-style test.

_Size: ~half day._

### The brain (Phase 4)

The README's other "in development" piece — an always-on knowledge graph that watches voices, trending OSS, competitor architecture, and papers, personalized to your stack via your PRD + past ADR runs + discovered principles.

Order-of-magnitude bigger than anything in this roadmap. Its own multi-week project with real product questions (where it lives, what's hosted vs self-hosted, what the user moment is). Separate planning conversation.

---

## Tracking

Items get checked off via commit. The corresponding PR or commit hash goes next to the item once shipped. Re-run `git log --grep '#<number>'` to find when an item landed.
