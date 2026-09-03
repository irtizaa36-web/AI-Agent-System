# Coworker task loop

A shared to-do list between the two Claude Code personas ("macmini" and
"Laptop2" — Irtiza calls them Max and Lucy in conversation, but the task
list and `SendMessage` still need the literal session names above; Max/Lucy
are friendly names, not values `--to`/`--persona` accept). Write down an
idea, say who it's for, and that persona picks it up on its own next
check-in — no one has to trigger it by hand.

## Coordinating between sessions

Live `SendMessage` between the sessions building/running this turned out to
be unreliable across session types (a cloud-hosted session can receive a
cross-session message but not reliably send one back). Rather than depend
on that, status updates and coordination between sessions happen as
comments on [issue #1](https://github.com/irtizaa36-web/AI-Agent-System/issues/1)
— check there any time `SendMessage` isn't landing.

**What goes where:** `coworker/tasks/` is for actual work — an idea someone
wants done. Issue #1 is for everything else that affects the loop itself —
status ("my check-in is live"), a bug in the protocol, a design question,
a blocker. Checking issue #1 is now a required step in the recurring
check-in below, not something to remember separately.

## Named projects

Ongoing pieces of work get a short reference name so every team/session means
the same thing when they mention it, in commit messages, issue #1, the
dashboard, or conversation with Irtiza:

- **Project Shivani** — the recurring job search + resume tailoring for
  Irtiza's wife, run via `job-search-agent` against her real resume and
  stated preferences (`.orchestrator/job-search/shivani-*.txt`, gitignored/
  local-only) and delivered via iMessage + the shared "Job Search Checkpoint"
  Google Doc. Not itself a `coworker/tasks/` entry (it's macmini's recurring
  routine, not dispatched work), but named here so it's referenced
  consistently anywhere else it comes up (e.g. the dashboard's Projects
  section, if/when it's wired up as a tracked project rather than only
  coworker tasks).

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
  "assignedTo": "macmini | Laptop2 | both",
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

- `add "<task text>" --to macmini|Laptop2|both` — write down a new idea.
- `list [--status pending|in_progress|done] [--for macmini|Laptop2]` — inspect the list.
- `dispatched <id> --persona macmini|Laptop2` — mark that a persona has picked the task up (call this right before starting the work).
- `complete <id> --persona macmini|Laptop2 --output "<summary>" [--failed]` — record what happened, once the work is actually done.

Run `npm run build` once, then call `node dist/cli/index.js coworker ...`
directly (that's what the recipe below uses). Don't use `npm run cli --
coworker ...` for this — npm's own arg-passing on Windows mangles a quoted
multi-word argument like `add "some idea"`, so a trigger built on it can
silently misfire.

## How a persona picks up its own work

**Before the first real run:** `git commit` needs a Git identity configured
on that machine (`git config --global user.name "..."` and `user.email
"..."`) — without it, a persona can finish real work and then get stuck
unable to commit/push the result. Confirm this is set before testing with a
real task, or the first test will look like a silent failure.

Each persona is responsible for noticing its own tasks — there's no central
dispatcher. Set up a recurring trigger (a Claude Code Remote Routine, or
whatever scheduling this machine has) whose prompt is along these lines:

> In the AI-Agent-System repo: `git pull`, then read the latest comments on
> [issue #1](https://github.com/irtizaa36-web/AI-Agent-System/issues/1) —
> act on anything addressed to you there before moving on. Then run
> `node dist/cli/index.js coworker list --status pending --for <macmini|Laptop2>`
> (substitute your own persona name; run `npm run build` first if `dist/`
> is stale or missing). If the list is empty:
> `node dist/cli/index.js agent-status set <you> --status idle` and stop.
> For each task listed:
> 1. `node dist/cli/index.js coworker dispatched <id> --persona <you>`
> 2. `node dist/cli/index.js agent-status set <you> --status working --task "<id or short description>"`
> 3. Do the actual work described in `task`, using whatever agents,
>    skills, tools, and connectors you already have — including this
>    repo's own `orchestrator run` / `orchestrator dispatch run` if one of
>    its Packs fits better than doing it yourself directly. If you get
>    genuinely stuck, `agent-status set <you> --status stuck --task "..."`
>    before moving on, rather than leaving the last status looking like
>    you're still quietly working.
> 4. `node dist/cli/index.js coworker complete <id> --persona <you> --output "<a short summary of what you did/found>"` (add `--failed` if it didn't work out, with the output explaining why).
> 5. `git add coworker/tasks coworker/agents && git commit -m "..." && git push` (if `push`
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

## The dashboard

`node dist/cli/index.js dashboard` (default port 4317; `--port N` to
change it) serves a local, read-only page at `http://localhost:<port>`
showing every agent's live status, every project (coworker task) and its
state, and a running feed of what the dashboard itself has noticed and
changed. It auto-refreshes every 15 seconds; there's also a manual
"Refresh now" button. No remote access or login — local only, for now.

It's built entirely from files already described above, plus one small
addition: `coworker/agents/<name>.json`, one per agent, holding that
agent's own latest self-report (`orchestrator agent-status set <name>
--status idle|working|stuck [--task "..."]`). The dashboard derives
"offline" itself — if an agent's last report is more than a few hours old,
it shows as offline even though nothing told it "I'm offline" (an agent
that's actually offline obviously can't report that about itself). Calling
`agent-status set` is already folded into the recurring check-in recipe
above; nothing extra to remember day-to-day.

`orchestrator recommend add "<summary>" --scope dashboard|system|<project>`
and `orchestrator recommend implemented <id> [--details "..."]` log the
"noticed / did" feed — anyone (any persona, not just the Coordinator) can
add to it.

## Safety note

This repo's own Packs (`personal-admin`, etc.) already split consequential
actions (sending an email, submitting a form) into a safe draft step and a
separate, gated send/submit step that needs a human's exact-match approval
(ADR 0004). If a coworker task ends up needing one of those, prefer running
it through `orchestrator run` / `orchestrator dispatch run` so that gate
still applies, rather than reaching for a raw, ungated tool that does the
same consequential thing. Never handle money. Nothing illegal.
