# Architecture

## Design goals

The runtime separates **intent**, **planning**, **execution**, and **side effects** so each layer can be tested and secured independently.

## Core concepts

### Task

A user request and its success criteria. A task is a specification, not an execution.

### Agent

A configured role that selects a model provider and an allowlist of tools. An agent definition is immutable configuration; a `Run` is the live execution.

### Run

A resumable execution record containing:

- task and agent identity
- ordered model/tool steps
- session messages
- current lifecycle status
- result or failure information
- pending approval data
- external thread correlation, when applicable

### Workflow

An ordered sequence of agent runs planned from a natural-language goal. Workflow execution stops at the first approval, external reply, or failure and can continue from that point.

## Execution lifecycle

```text
queued → running → succeeded
                 ↘ failed
                 ↘ awaiting_approval → waiting_for_response → running
```

`runToCompletion` accepts lifecycle hooks. Persistence and dashboards should subscribe to those hooks so every intermediate state is saved, not only the final state.

## Tool boundary

Tools are capabilities, not model providers:

- Providers generate model responses.
- Tools perform I/O against the outside world.
- Core orchestration coordinates them without importing vendor or integration code.

A tool must declare a stable name, description, input schema, and executor. Consequential tools set `requiresApproval: true` and must independently validate the live state before performing the side effect.

## Persistence

The default stores use one JSON file per record. Writes are performed through a temporary file followed by an atomic rename, preventing a process crash from leaving a partially written run or workflow.

For production deployment, replace these adapters with a transactional database implementation that supports:

- optimistic concurrency
- indexed status queries
- leases for active runs
- retention policies
- encrypted sensitive fields

## Extension points

- Add a provider under `src/providers/`.
- Add a tool under `src/tools/`.
- Add external service clients under `src/integrations/`.
- Add a workflow or domain pack under `src/packs/`.
- Keep orchestration contracts small and dependency-free.
