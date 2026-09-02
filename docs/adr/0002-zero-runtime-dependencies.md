---
status: accepted
---

# Zero runtime dependencies for the initial CLI

The initial orchestrator uses only Node's built-ins: `fetch` for the Anthropic provider, `node:test` for tests, and `node:util.parseArgs` for CLI argument parsing, instead of an HTTP client, a test framework, or a CLI-argument library. This was a deliberate choice, not an oversight — the point at which a real need (e.g. subcommand help formatting, streaming responses) outgrows a built-in is the point to add the corresponding dependency, not before. `typescript` and `@types/node` remain as dev-only dependencies, since the project's language choice requires them.
