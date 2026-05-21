# Benchmark Case: Docs Support Knowledge Base

We are building a product documentation and support knowledge base for a developer tool.

The system answers self-contained lookup questions over docs, changelogs, troubleshooting guides, and support articles. Most queries ask for a specific feature, configuration flag, error message, or step-by-step setup instruction.

Representative questions:

- How do I configure the local daemon?
- What does this CLI flag do?
- Which docs page explains workspace setup?
- How do I fix this installation error?

Important constraints:

- Low latency matters more than deep reasoning.
- The answer should cite the relevant docs page or support article.
- Metadata filters for product version, operating system, and package name are important.
- The domain does not require multi-hop legal traceability or graph traversal.
- The system should avoid over-engineered agent loops for normal documentation lookup.
