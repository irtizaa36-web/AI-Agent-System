# Coworker task loop

A shared to-do list between the Claude Code personas doing the actual work
— "macmini" and "Laptop2" (Irtiza calls them Max and Lucy in conversation;
the task list and `SendMessage` still need the literal session names, not
the friendly ones), plus specialists added as real needs come up:
"Riley" owns the dashboard itself; "Jordan" handles IT/technical support —
diagnosing environment, connectivity, and setup issues across machines, and
watching the dashboard for any agent showing offline or stuck. Write down
an idea, say who it's for, and that persona picks it up on its own next
check-in — no one has to trigger it by hand.

Jordan's real limit, worth stating plainly: if the problem is a session's
own connection to a machine being down, no agent — Jordan included — can
click things on that screen. It can diagnose and tell Irtiza exactly what
to try; the physical step is still his.

## Coordinating between sessions

Live `SendMessage` between the sessions building/running this turned out to
be unreliable across session types (a cloud-hosted session can receive a
cross-session message but not reliably send one back — confirmed
repeatedly, an explicit auth error, not a timeout: "this cloud session
cannot message other sessions yet"). Rather than depend on that, status
updates and coordination between sessions happen as comments on
[issue #1](https://github.com/irtizaa36-web/AI-Agent-System/issues/1) —
check there any time `SendMessage` isn't landing.

**A session's `SendMessage`/`ListAgents` peer name is not its title, and
none of us can set it.** Confirmed directly: a cloud session's own
`ListAgents` self-name (e.g. `ai-agent-system-a7`) is an unrelated
auto-generated id that doesn't match its actual session `title` (e.g.
"Jordan — IT/Technical Support Coworker") — and that auto-generated name
isn't even stable, it can rotate across turns of the same session. For a
local/bridge (Remote Control) session the peer name instead appears tied
to the physical machine's Remote Control connection/device registration,
not the session record at all — so when macmini's session was recreated
after its environment was deleted (2026-09-03), the new session kept
`ListAgents`-addressable as an unrelated auto-name while a stale, offline
`macmini` entry from the dead session lingered and would still catch a
`SendMessage` sent to `"macmini"` by name. `set_session_title` only
changes the record's display title, not this peer-address name — there's
no tool available to any persona here that reassigns it. Practical
takeaway: don't rely on a persona's plain name for `SendMessage` unless
you've just confirmed it resolves (a stale entry can shadow a live
session with the same intended identity) — issue #1 stays the reliable
fallback regardless, and if you must reach a specific session directly,
address it by its full `session_...` id from `list_sessions`/`get_session`,
not by the friendly name.

**What goes where:** `coworker/tasks/` is for actual work — an idea someone
wants done. Issue #1 is for everything else that affects the loop itself —
status ("my check-in is live"), a bug in the protocol, a design question,
a blocker. Checking issue #1 is now a required step in the recurring
check-in below, not something to remember separately.

## Named projects

Ongoing pieces of work get a short reference name so every team/session means
the same thing when they mention it, in commit messages, issue #1, the
dashboard, or conversation with Irtiza:

- **Project Shivani — RETIRED (2026-09-04), being restarted fresh.** Was the
  recurring job search + resume tailoring for Irtiza's wife, run via
  `job-search-agent` against her real resume and stated preferences
  (`.orchestrator/job-search/shivani-*.txt`, gitignored/local-only) and
  delivered via iMessage + the shared "Job Search Checkpoint" Google Doc.
  Irtiza asked to clear all responsibilities for this version of the project
  and start it new — **macmini should stop its recurring Shivani check-in
  routine** (the standing "read her iMessage thread a few times a day" prompt)
  until a new version of this project is defined. Her local resume/preference
  files and the checkpoint doc are untouched — nothing was deleted, the
  routine is just paused. Left here for history/reference rather than
  deleted outright; replace this entry once the new project has a shape.

- **PinkyBaby** — Team B's Lead Agent. Owns triage, integration, durable
  handoffs, and tasks that require Team B coordination.

## Current focus (2026-09-04)

Per Irtiza's explicit direction: **all projects other than the Dashboard are
on hold** until further notice. Concretely:
- **Dashboard** (Riley's ownership, plus anything the dashboard itself
  depends on, like its autostart LaunchAgent) — stays active, keep working it.
- **Everything else** (Project Shivani, the Mac Mini optimization pass, new
  connector integrations, etc.) — pause. Don't pick up new work on these;
  existing in-flight items should be left in a clean, clearly-described state
  (an update note, not silence) rather than abandoned mid-task.
- Two new projects are coming from Irtiza directly; once assigned, they and
  the Dashboard are the priority (~95% of effort) until he says otherwise.
- This is a standing instruction until replaced by a newer dated entry here —
  don't assume it has lapsed just because time has passed; check issue #1 for
  an explicit "resume" instead.

- **PinkyBaby** — Team B's Lead Agent. Owns triage, integration, durable
  handoffs, and tasks that require Team B coordination.

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
  "assignedTo": "macmini | Laptop2 | Riley | both",
  "results": {
    "macmini": { "status": "pending | dispatched | succeeded | failed", "output": "…" }
  },
  "updates": [
    { "at": "…", "by": "macmini | Irtiza | anyone", "note": "a short progress note" }
  ]
}
```

There's no separate top-level status field — it's always derived from
`results` (via `coworkerTaskOverallStatus` in `src/coworker/task.ts`) so the
two can't drift out of sync. `orchestrator coworker list` shows the derived
`pending` / `in_progress` / `done` for you.

`updates` is separate from `results` on purpose: it's a running log of
progress notes ("checking on it," "found three matches, reviewing now"),
not a status change. It's what makes an *ongoing* project — one that never
really finishes, like a recurring check-in — still show a meaningful "most
recent update" on the dashboard instead of sitting at "pending" forever.
Anyone can post one, not just the assigned persona.

## The commands (`orchestrator coworker ...`)

- `add "<task text>" --to macmini|Laptop2|Riley|both` — write down a new idea.
- `list [--status pending|in_progress|done] [--for macmini|Laptop2|Riley]` — inspect the list.
- `dispatched <id> --persona macmini|Laptop2|Riley` — mark that a persona has picked the task up (call this right before starting the work).
- `undispatch <id> --persona macmini|Laptop2|Riley` — return interrupted work to `pending`, clearing stale dispatch metadata so a later check-in can pick it up.
- `complete <id> --persona macmini|Laptop2|Riley --output "<summary>" [--failed]` — record what happened, once the work is actually done.
- `update <id> --by <name> --note "<text>"` — post a progress note, without changing status. For an ongoing project (see below), post one of these periodically instead of ever calling `complete`.

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

If a session expires or a machine becomes unavailable after a task was marked
`dispatched`, use `undispatch` before the next pickup cycle. Dispatched tasks
do not appear in the normal pending-task query, so this recovery step prevents
interrupted work from being stranded.

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
change it) serves a local page at `http://localhost:<port>` showing every
agent's live status, every project (coworker task) with its most recent
update, and a running feed of what's been noticed and changed. It
auto-refreshes every 15 seconds; there's also a manual "Refresh now"
button. No remote access or login — local only, for now.

It's not just read-only: the page itself can add a new task (the "Add a
task" form) and post a progress note on any project — this is meant to be
the normal way to hand over an idea or check on something, not just a chat
message to the Coordinator. Both write straight to the same
`coworker/tasks/*.json` files everything else here reads, via two small
endpoints (`POST /api/tasks`, `POST /api/tasks/:id/updates`) with no auth,
since the page itself has none yet either.

Built entirely from files already described above, plus one small
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

### Operational updates

Operational updates are concise, authored status or handoff records that do
not change a task's lifecycle and are not recommendations. They are committed
as one JSON file per entry in `coworker/operational-updates/` and appear in
the dashboard's **Operational updates** feed. Use them for safe summaries such
as merged dashboard work, platform-optimizer status, or a required operator
follow-up:

```text
node dist/cli/index.js operational-update add "Dashboard review queue merged" --by PinkyBaby --provenance agent
node dist/cli/index.js operational-update add "Restart required to finish updates" --by Irtiza --provenance external_operator
```

`--provenance` is required and is one of `human`, `agent`, or
`external_operator`. Do not record personal data, mailbox contents, credentials,
or data scraped from a remote service.

### Tracking an ongoing project (no real "done")

Some real work — Shivani's job-search check-in, for instance — never
finishes; it just keeps running. Represent it as a normal coworker task
(`coworker add "..." --to <persona>`) that never gets `complete`d, and have
whoever runs it call `coworker update <id> --by <persona> --note "..."`
each time something happens (a new match found, a reply received). The
dashboard shows its latest note as "most recent update" and its overall
status stays `in_progress` — that's correct and expected for something
that's ongoing by design, not a sign it's stuck.

## Keep usage-credit cost down

Standing rule, not a one-time fix (from Irtiza, 2026-09-03): the biggest
cost driver in this loop is how often a persona wakes up and re-processes
an ever-growing session context, not the actual work itself. So:

- **Default a new recurring check-in to a few hours, not high-frequency
  polling.** 30 minutes is too frequent for how this loop is actually
  used; most personas should be at 3-4+ hours unless a specific task is
  genuinely time-sensitive. As of 2026-09-03: Coordinator every 4h,
  macmini every 3h, Jordan every 6h — everyone else, cut your own trigger
  the same way (you own it; the Coordinator can't modify a Routine it
  didn't create).
- **Why frequency alone is a partial fix, verified not assumed (Jordan,
  2026-09-03):** every one of our recurring check-ins today is a
  *persistent-session-bound* Routine (`persistent_session_id` set to one
  fixed session) — each fire resumes the same ever-growing conversation,
  and prompt-cache reads are not free (~0.1x input price on Sonnet 5, not
  0x) — so each fire re-pays a small tax on the *entire* accumulated
  history so far. Confirmed on Jordan's own session: 8.1M cache-read
  tokens and ~$4.50 after one day at a 2h cadence. Cutting frequency
  slows that growth; it doesn't stop it from compounding.
  `create_new_session_on_fire: true` (vs. a persistent
  `persistent_session_id`) is a real, working alternate Routine mode —
  confirmed via `list_triggers`: unrelated triggers on this account
  (e.g. "Daily Morning Brief") get a distinct session id on every fire,
  proof they don't accumulate. A fresh-session fire's cost stays roughly
  constant instead of growing, and this protocol already keeps all real
  state in git/issue #1, not conversation memory, so nothing would be
  lost. Real tradeoff, not yet decided as of this writing: a
  fresh-session fire no longer lands in an ongoing chat thread you can
  scroll back through — its only trace is what it writes to git/issue
  #1 (or a completion notification). Worth migrating the *recurring
  check-in* triggers to this mode once someone signs off on that
  visibility change; see issue #1 for the full writeup.
- **On a "nothing to do" cycle, keep it to the shortest real check** — git
  pull, read issue #1, list your pending tasks, done. Don't re-read full
  docs or re-verify things that haven't changed since last time.
- **Prefer a cheaper/faster model for simple, low-stakes routine checks**
  where you actually have that choice; save heavier reasoning for real
  task work, not "is there anything to do."
- If you notice a cheaper way to run any part of this loop, that's exactly
  the kind of thing to log via `orchestrator recommend add --scope system`
  and just implement — this falls squarely under standing autonomy, not
  something to ask permission for each time.

## Safety note

This repo's own Packs (`personal-admin`, etc.) already split consequential
actions (sending an email, submitting a form) into a safe draft step and a
separate, gated send/submit step that needs a human's exact-match approval
(ADR 0004). If a coworker task ends up needing one of those, prefer running
it through `orchestrator run` / `orchestrator dispatch run` so that gate
still applies, rather than reaching for a raw, ungated tool that does the
same consequential thing. Never handle money. Nothing illegal.
