# AI-Agent-System

## Project context

Read `PROJECT-BRAIN.md` first — it's the durable, plain-English briefing on what this project is, what actually exists vs. what's only planned, the standing architectural principles, safety boundaries, and how this project expects Claude Code to work. See also `CONTEXT.md` (domain vocabulary) and `docs/adr/` (why specific architectural decisions were made).

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`CONTEXT.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.
