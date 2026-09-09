# AI Agent System

A model-agnostic, CLI-first runtime for building AI agents that can reason, use tools, pause for human approval, and resume safely.

## What it provides

- **Agents** with a provider, model, system prompt, and allowed tools
- **Runs** that record task instructions, messages, tool calls, results, and lifecycle state
- **Workflows** that route a goal through multiple agents in order
- **Approval gates** for consequential actions such as sending email or submitting a web form
- **Provider adapters** so the core runtime stays independent of a model vendor
- **Persistent stores** for resumable runs and workflows
- **CLI, dashboard, integrations, and packs** for composing product-specific experiences

## Quick start

Requirements: Node.js 22 or newer.

```bash
npm install
npm test
npm run build
npm run cli -- --agent demo "Say hello"
```

To use the Claude provider, set `ANTHROPIC_API_KEY` in the environment or in a local `.env` file. Never commit credentials.

## Runtime model

```text
Task → Agent → Run → Model response → Tool calls → Run update
                                      ↓
                           approval required?
                             yes → pause
                             no  → execute
```

Every consequential tool must be explicitly approved with the exact input that the agent proposed. A resumed run can continue after approval or an external reply without rebuilding its context from scratch.

## Repository layout

- `src/core/` — agent, task, run, session, workflow, and orchestration contracts
- `src/providers/` — model-provider adapters and deterministic test providers
- `src/tools/` — capabilities an agent can invoke
- `src/store/` — in-memory and JSON-file persistence adapters
- `src/integrations/` — external service clients
- `src/cli/` — command-line entry points and runtime wiring
- `src/dashboard/` — operational UI and run visibility
- `docs/` — architecture and security guidance

## Safety principles

1. Reading and drafting are separate from consequential execution.
2. Approval is matched against the exact proposed input.
3. Provider failures become failed runs instead of uncaught process errors.
4. Persisted records are written atomically to avoid partial JSON state.
5. Approval-gated turns contain one action so no unapproved call can be silently dropped.
6. Tool implementations validate their own inputs and independently re-check live state before side effects.

## Developing a tool

A tool should expose a clear name, description, JSON-compatible input schema, and an `execute` function. Add a test for valid input, invalid input, external failures, and approval behavior. Keep provider and integration I/O outside `src/core/` so the core remains deterministic and easy to test.

## Big Boss continuity handoff

The repository is also the durable source of truth for the user's cross-agent operating system. The central Polar orchestration session, called **Big Boss**, should read the continuity handoff before beginning substantial work:

- [Big Boss continuity handoff](docs/BIG-BOSS-HANDOFF.md)

Big Boss should also inspect `CLAUDE.md`, `CONTEXT.md`, `PROJECT-BRAIN.md`, relevant files under `docs/`, and recent repository changes. Never commit credentials, tokens, cookies, or protected health information.

## Status

This project is actively evolving. The next priorities are richer lifecycle telemetry, stronger evaluation fixtures, and a production-grade queue/API around the core runtime.
