# Benchmark Case: Open-Ended Market Research

We are building an analyst research workspace for market landscape exploration.

The system needs to investigate open-ended questions across public websites, reports, product pages, company announcements, and analyst notes. Users ask the system to discover competitors, compare product positioning, identify pricing signals, and synthesize strategic observations.

Representative questions:

- Investigate which companies are entering this category.
- Compare three product approaches and explain the trade-offs.
- Discover evidence that a market is shifting toward agentic workflows.
- Research recent announcements and summarize the strategic implication.

Important constraints:

- The research loop may use tools and multiple source types.
- The answer path does not mutate source-of-truth product state.
- Exact p95 latency is less important than coverage and source diversity.
- The system needs citations, but it does not require compliance-grade graph lineage.
- The architecture should not pretend this is a deterministic document lookup problem.
