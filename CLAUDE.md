# AI-Agent-System

## Project context

Read `PROJECT-BRAIN.md` first — it's the durable, plain-English briefing on what this project is, what actually exists vs. what's only planned, the standing architectural principles, safety boundaries, and how this project expects Claude Code to work. See also `CONTEXT.md` (domain vocabulary) and `docs/adr/` (why specific architectural decisions were made).

## Cross-team continuity

This repository is the shared source of truth for Team B and any alternating team. Before starting or handing off work, follow `docs/agents/team-handoff.md`.

## Claude-compatible continuity

The repository must remain usable from Claude Code, a Claude project, Polar, GitHub Copilot, or another compatible client without private conversation history. Start with `docs/claude/README.md`.

Priority task guides:

- `docs/claude/job-search.md` — copy-ready, read-only job discovery, fit assessment, and truthful resume tailoring.
- `docs/claude/public-agent-creation.md` — copy-ready public-facing Agent design, least-privilege tools, tests, approval gates, and rollback planning.
- `docs/claude/portable-handoff.md` — structured handoff format for moving work between clients.

When a client lacks a repository Tool, preserve the task's output contract and record the limitation under Missing Information. Never invent a listing, source, test result, credential, or completed side effect.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Public.com monitoring

A standalone monitoring and trade-drafting system lives in `src/tools/public-trading/`. Read `docs/operations/public-trading.md` before touching it. Two boundaries hold without exception: it never places an order (its client interface exposes no method that could), and it is separate from — not a supervisor of — the Public.com Agents in `docs/registry/PROJECT-REGISTRY.md` §8.

### Domain docs

Single-context layout (`CONTEXT.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.

## Validation

The project requires Node 22 or later. For TypeScript changes, run:

```bash
npm ci
npm test
```

For documentation-only changes, run `git diff --check` and review links and safety boundaries. Do not commit `.env`, credentials, browser sessions, connector registrations, mailbox contents, or private personal data.
