# Local Operations

## Scope

This runbook describes the local operational shape of Moby AI without storing credentials, private files, browser sessions, message content, or machine-specific secrets. The repository remains the source of truth for code and durable coordination; local runtime state is deliberately separate.

## Checkouts

- A Team B worktree is for isolated development and should start from `origin/main`.
- The primary Mac mini checkout is the runtime location for locally managed services. A merge to `main` does not update a running process by itself.
- Before changing a local service, confirm its checkout, current commit, working-tree status, and the corresponding commit on `origin/main`.

## Inkbox webhook

The webhook receiver is a local Node process managed by a user LaunchAgent. Its default listener is port `8787`, and its health endpoint is:

```text
http://localhost:8787/inkbox/mail/health
```

The response states whether bearer authentication is required but never reveals the token. Runtime configuration comes from a local `.env` file; only `.env.example` is committed. Its logs and persisted runtime data live under `.orchestrator/`, which is also local-only.

Use the health endpoint and `launchctl print gui/<uid>/com.aiagentsystem.inkbox-webhook` for read-only inspection. A service update requires human review because it may change a live process using real communication credentials.

## Dashboard and coworker loop

The dashboard is local-only and starts with:

```text
node dist/cli/index.js dashboard
```

It defaults to `http://localhost:4317`. It reads and writes committed coordination records under `coworker/`; status data is self-reported, so stale reports are not proof that a persona is idle or active.

Issue #1 is the durable coordination fallback when cross-session messaging is unavailable. Use `coworker undispatch <id> --persona <name>` to return work stranded by an interrupted session to the normal pending-task pickup queue.

## Local-only dependencies

These resources must never be committed or copied into a handoff:

- `.env` credentials and tokens
- `.orchestrator/` runtime records, drafts, logs, and browser sessions
- personal files used by a Pack
- local scheduler and LaunchAgent registrations

When a task depends on one of these, record the dependency and its required machine in the GitHub Issue or coworker task without recording its contents.
