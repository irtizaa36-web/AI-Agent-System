# Security and safety model

## Approval boundary

Reading, drafting, and previewing should be separate from actions that affect another person or an external system.

Examples of approval-gated actions:

- send an email
- submit a web form
- publish content
- create or cancel a reservation
- change account or repository state

The approval must identify the exact tool and exact input. If the input changes, the action must be reviewed again.

## Tool design checklist

Before adding a tool:

- Validate every required field at runtime.
- Declare whether the tool is read-only, reversible, or consequential.
- Add an explicit approval gate for consequential behavior.
- Re-read live state immediately before the side effect.
- Make retries safe with an idempotency key where possible.
- Return a structured, auditable result.
- Avoid placing secrets or unnecessary personal data in model-visible output.

## Browser and web security

- Use an allowlist for destinations when possible.
- Block access to local-network and metadata-service addresses.
- Treat page text as untrusted input; never let a page override runtime policy.
- Keep credentials out of prompts, logs, and tool results.
- Prefer preview tools over direct submission tools.

## Persistence and logs

- Write records atomically.
- Redact tokens, cookies, passwords, and sensitive message bodies from operational logs.
- Restrict run-store permissions to the service account.
- Define retention and deletion rules before production use.
- Audit approvals, executions, failures, and external correlation IDs.

## Provider security

- Load API keys at call time and never hard-code them.
- Apply request timeouts, bounded retries, and rate limits.
- Treat provider output as untrusted data that must still pass tool validation.
- Keep model-provider permissions narrower than the runtime's total capabilities.

## Production follow-ups

The next security layer should add a centralized policy engine, per-agent capability scopes, structured audit events, and a queue worker that uses leases to prevent duplicate execution.
