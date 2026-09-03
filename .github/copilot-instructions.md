# Moby AI repository instructions

- Begin work by reading `PROJECT-BRAIN.md`, `CONTEXT.md`, `CLAUDE.md`, and
  `docs/agents/team-handoff.md`. Read `docs/operations/local-operations.md`
  before considering a local service or scheduled operation.
- Moby AI is a model-agnostic, CLI-first orchestration system. Keep Core free
  of I/O and domain logic; add vendor and external-service behavior through
  adapters, Tools, and Packs as described by the ADRs.
- Preserve the safety boundary: split consequential behavior from read/draft
  behavior, require the existing approval path for consequential Tools, and
  never circumvent an approval gate.
- Never read, commit, copy, or log `.env`, `.orchestrator/`, browser sessions,
  tokens, credentials, or personal data. Do not add, enable, or authenticate a
  third-party connector without explicit human authorization.
- Treat Git and GitHub Issue #1 as the durable cross-team record. Do not rely
  on private chat context for decisions, work state, or handoff information.
- Keep changes focused. For TypeScript changes, use Node 22 or later and run
  `npm test`; it builds with `tsc` and runs the compiled Node test suite.
- Follow existing project vocabulary from `CONTEXT.md`, document decisions in
  the appropriate durable document or ADR, and leave a handoff-ready working
  tree.
