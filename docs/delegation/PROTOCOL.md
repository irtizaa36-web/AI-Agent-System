# Orchestration & Delegation Protocol

Every Claude Code session working in this repo follows this protocol.
It is the durable copy of the "Toozy Ops" Project's orchestration
instructions. If this file and a chat instruction conflict, the owner's
latest explicit instruction wins, and this file should then be updated.

## Roles

- **Owner** (Dr. Toozy, GitHub `irtizaa36-web`): final authority. Sets
  priorities and approves anything outside the hard rules below.
- **Orchestrator** (claude.ai Project "Toozy Ops"): plans, sequences
  the backlog, and writes task briefs. It dispatches work to Code
  sessions, integrates their results, and reports back to the owner.
  It does repo work directly only when it has write access.
- **Code session**: does the repo work on its own branch
  (`claude/<task>-<suffix>`). It owns implementation, tests, the PR,
  and the delegation log for its task.
- **Muse**: owns Toozy's personal operations and receives delegated
  items through the delegation log (see the split-brain rule).

## Split-brain rule

Claude Code owns code and repo work: diagnosis, design, implementation,
tests, PRs. Muse owns Toozy's personal operations: accounts,
credentials/vault, schedules, messages, memory, standing rules.

Delegate to Muse:
- anything needing Toozy's personal context or credentials
- anything sent, posted, or published as him
- mechanical extraction, formatting, or fetch tasks

Handle in the session: diagnosis, solution design, implementation, test
runs, PRs.

Never touch credentials or secrets. Never merge except on green CI.
Final approvals are Toozy's alone.

## Orchestrator brief watcher

`orchestrator watch-briefs poll` (ADR 0027) polls the GitHub API for new
brief files on `claude/*` branches, roughly every 3 minutes — the same
cadence and "a branch push is the trigger" shape as Muse's watcher below,
so the two stay consistent.

A brief is a markdown file at `docs/delegation/briefs/<task>.md` on any
`claude/*` branch:

```
# <Task title>

Target branch: `claude/<task>-<suffix>`

<free-form body — instructions for the Code session picking this up>
```

The Orchestrator writes this file (directly or via its own branch) when it
wants a Code session dispatched. On finding a new one, the watcher checks
out (or reuses) the named target branch, writes a starter
`trial/delegation-log.md` there with the brief's own text and empty
Diagnosis/Delegation-table/Budget-status headings, and pushes that one
commit. It never opens or merges a PR and never runs the brief itself —
picking it up from there (reading the brief, doing the work, opening the
PR) is a Code session's job, same as any other task under this protocol.

## Delegation mechanics

Each session keeps `trial/delegation-log.md` on its session branch and
pushes the branch. That file is the only channel for delegating to
Muse. Muse's watcher polls the GitHub API for that path on new
`claude/*` branches, roughly every 3 minutes. The branch push is the
pickup trigger; opening a PR is not required. Once picked up, Muse
executes the delegated items and reports back to Toozy in the Muse
chat.

For every subtask, record a row in the delegation table:

| Subtask | Disposition | Reasoning |
|---|---|---|

Dispositions:
- `Handled [RUBRIC]`: kept because the subtask needs judgment
  (diagnosis, design, architectural tradeoffs, core engineering).
- `Handled [STRUCTURE]`: kept for structural reasons. Delegating would
  only add latency, or the session already has direct access.
- `Handled [QUOTA]`: would have been delegated, but Muse's allowance is
  low, so the item stays local and the reason is logged.
- `Delegated to Muse`: falls under Muse's side of the split-brain rule,
  or is mechanical, exactly specified, and verifiable.

Each delegated item **must** include all three of the following:

- **Input:** exactly what Muse receives, with full text inline and no
  "see above."
- **Output:** the concrete end state.
- **Success criteria:** checkable conditions that prove it's done,
  including anything that must be preserved verbatim.

The log also records the diagnosis, what was implemented, test counts,
budget status, and any pending "integration round" items.

## Hard rules

1. **Never merge red.** Merge only when CI is green. If CI fails, fix
   it or leave the PR open and report it.
2. **Never invent results.** No fabricated test counts, listings,
   sources, credentials, or completed side effects. Report what
   actually happened, including failures.
3. **No outbound side effects without owner approval.** This covers
   SMS, email, DMs, credential changes, and account or settings
   changes. Existing approval gates stay intact.
4. **Social accounts are read-only.** Never like, reply, repost,
   follow, or DM, including from @WoozyBets.
5. **No money movement.** No financial transactions outside existing,
   owner-approved gated tools.
6. **Never touch or commit secrets or private data.** That includes
   `.env` files, tokens, the credentials vault, browser sessions,
   connector registrations, mailbox contents, and personal data.
7. **Don't test against a degraded live session.** If a live account
   is throttled or blocked, don't generate more automated traffic to
   validate a fix. Let the next scheduled run be the validation.
8. **Back off, don't hammer.** If a tool or action keeps failing, wait
   briefly instead of retrying repeatedly.
9. **One task, one PR.** Don't bundle unrelated features into one PR.

## Budgets

**Credit order**
- The $100 promo credit (claimed 2026-09-26) burns first on cloud
  sessions.
- Weekly credits are fallback only. Never touch them while promo
  balance remains.

**Per-session limits**
- Spend cap: $15 of promo per session.
- At $7.50, warn yourself.
- At $12, stop non-essentials and return a partial result plus a
  triage plan.
- Wall time: 45 minutes per session.
- Any subtask that would take more than 10 minutes is a delegation
  candidate, even if it needs little judgment.

**Bilateral protection**
- Neither Claude's weekly credits nor Muse's weekly allowance may run
  dry.
- If both run low, return a triage plan (defer / reduce fidelity / ask
  Toozy) instead of spending quota.

**Logging and overruns**
- The delegation log records budget status at write-up time.
- If a task won't fit in budget, deliver the smallest shippable slice,
  open the PR, and log what remains.

## Reporting back to the orchestrator

Every session ends with:
- PR URL(s)
- Test counts (`npm test` pass/total) and `tsc --noEmit` status
- Merge status (merged / open-awaiting-CI / open-red plus the reason)
- A link to or the contents of `trial/delegation-log.md`
