# Coworker task loop

A shared to-do list between the two Claude Code personas ("macmini" and
"Laptop"). Write down an idea, say who it's for, and that persona picks it
up on its own next check-in — no one has to trigger it by hand.

## Where the list lives

`coworker/tasks/<id>.json` — one small JSON file per task, committed to
this repo. Both personas work from their own clone, so "shared" means:
**pull before you look, push after you write.** Per-task files (rather than
one big list) mean two different tasks being updated on two machines at the
same time never touch the same file. The only real collision risk is both
personas finishing the *same* `"both"` task in the same instant — rare, and
if it ever happens it's a trivial JSON merge, not worth building locking
for.

Open a task's `.json` file directly if you just want to look — that's the
point of using plain files instead of a database.

## Shape of one task

```json
{
  "id": "…",
  "createdAt": "2026-09-03T00:00:00.000Z",
  "task": "the idea/instructions, in plain English",
  "assignedTo": "macmini | Laptop | both",
  "results": {
    "macmini": { "status": "pending | dispatched | succeeded | failed", "output": "…" }
  }
}
```

There's no separate top-level status field — it's always derived from
`results` (via `coworkerTaskOverallStatus` in `src/coworker/task.ts`) so the
two can't drift out of sync. `orchestrator coworker list` shows the derived
`pending` / `in_progress` / `done` for you.

## The commands (`orchestrator coworker ...`)

- `add "<task text>" --to macmini|Laptop|both` — write down a new idea.
- `list [--status pending|in_progress|done] [--for macmini|Laptop]` — inspect the list.
- `dispatched <id> --persona macmini|Laptop` — mark that a persona has picked the task up (call this right before starting the work).
- `complete <id> --persona macmini|Laptop --output "<summary>" [--failed]` — record what happened, once the work is actually done.

Run `npm run build` first (or `npm run cli -- coworker ...`, which builds for you).

## How a persona picks up its own work

Each persona is responsible for noticing its own tasks — there's no central
dispatcher. Set up a recurring trigger (a Claude Code Remote Routine, or
whatever scheduling this machine has) whose prompt is along these lines:

> In the AI-Agent-System repo: `git pull`, then
> `npm run cli -- coworker list --status pending --for <macmini|Laptop>`
> (substitute your own persona name). For each task listed:
> 1. `npm run cli -- coworker dispatched <id> --persona <you>`
> 2. Do the actual work described in `task`, using whatever agents,
>    skills, tools, and connectors you already have — including this
>    repo's own `orchestrator run` / `orchestrator dispatch run` if one of
>    its Packs fits better than doing it yourself directly.
> 3. `npm run cli -- coworker complete <id> --persona <you> --output "<a short summary of what you did/found>"` (add `--failed` if it didn't work out, with the output explaining why).
> 4. `git add coworker/tasks && git commit -m "..." && git push` (if `push`
>    fails because the remote moved, `git pull --rebase` once and push
>    again).
>
> Do this without asking for confirmation on each step, but never touch
> money/payments, and stop and flag anything that seems illegal or that a
> reasonable person would want to weigh in on first.

`SendMessage` between the two persona sessions is still there for anything
that isn't this loop — asking each other a question, flagging something
mid-task — but the loop itself doesn't depend on either session already
being open: a fresh, scheduled headless run is enough.

**Two different kinds of trigger, and the task record doesn't pick between
them yet.** A cloud-sandboxed trigger (e.g. Claude Code Remote's Routines)
spawns a fresh session with this repo and already-connected tools, but no
access to that physical machine's own local state (a saved Playwright
browser login, local files outside this repo). A trigger that runs a real
Claude Code process *on* the Mac mini or laptop itself (cron/launchd
invoking the `claude` CLI there) has that local state, but needs something
already running/scheduled on that specific machine. If a task genuinely
needs the local-only kind, say so in the task text for now (e.g. "(needs
the local browser session)") — there's no dedicated field for it yet; add
one once it's clear it's needed often enough to justify tracking.

Rule of thumb for which kind a task needs: if it depends on anything
gitignored/local-only on one specific machine — a `.env` API key, a saved
browser-login session, a personal data file kept out of the repo on
purpose — it needs that machine's own real local trigger, not a
cloud-sandbox spawn.

## Safety note

This repo's own Packs (`personal-admin`, etc.) already split consequential
actions (sending an email, submitting a form) into a safe draft step and a
separate, gated send/submit step that needs a human's exact-match approval
(ADR 0004). If a coworker task ends up needing one of those, prefer running
it through `orchestrator run` / `orchestrator dispatch run` so that gate
still applies, rather than reaching for a raw, ungated tool that does the
same consequential thing. Never handle money. Nothing illegal.
