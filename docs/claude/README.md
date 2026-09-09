# Claude-Compatible Operating Guide

This directory contains portable instructions that can be used by Claude Code, a Claude project, or another model client without depending on Polar-only memory, browser state, connectors, or private chat history.

## Start here

1. Read `PROJECT-BRAIN.md`, `CONTEXT.md`, and `CLAUDE.md`.
2. Read `docs/operations/ai-client-interoperability.md` and `docs/agents/team-handoff.md`.
3. Choose the task guide:
   - `job-search.md` for job discovery, fit assessment, and truthful resume tailoring.
   - `public-agent-creation.md` for designing a public-facing Agent definition and launch checklist.
   - `portable-handoff.md` when moving work between Claude, Polar, Copilot, or another session.
4. Inspect the current Git status and relevant GitHub Issue before changing code.
5. Run `npm ci` and `npm test` for code changes. The project requires Node 22 or later.

## Portability contract

Every substantial task should leave behind:

- the exact prompt or procedure used;
- structured inputs and outputs;
- sources and assumptions;
- current status and unresolved questions;
- a clear next action;
- no secrets, credentials, browser sessions, connector registrations, or private personal data.

A client may have different tools. If a tool is unavailable, preserve the same output contract and mark the missing capability in `Missing Information`; do not pretend that the action occurred.

## Side-effect boundary

The job-search workflow is informational and read-only. It must not apply to jobs, contact employers, or submit anything.

The public-agent workflow designs and validates an Agent definition. It must not publish, enable, install, authenticate, or change an external account without a separate explicit operator action.

## Model/provider boundary

The repository remains model-agnostic. Claude is the default provider in the current runtime, but prompts and task specifications must not depend on private Claude conversation history. Domain behavior belongs in Packs; provider behavior belongs behind the Provider interface; external I/O belongs in Tools.
