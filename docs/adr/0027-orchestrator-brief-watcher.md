---
status: accepted
---

# An orchestrator brief watcher, and why it's read-detect-checkout, not run-and-merge

`docs/delegation/PROTOCOL.md` names the missing piece explicitly: Muse's watcher already polls the GitHub API for `trial/delegation-log.md` on new `claude/*` branches roughly every 3 minutes, treating the branch push itself as the pickup trigger. Nothing on the Code-session side did the equivalent for the Orchestrator's own dispatch mechanism — a human still had to notice a new task brief and manually start a Code session against it. This ADR builds that watcher and defines the brief format it reads, so the two watchers (Muse's and this one) use the same cadence and the same "a branch push is the trigger" shape, per the bootstrap task's explicit ask to keep them consistent.

## Decision

**The brief format** (documented for humans in PROTOCOL.md): a markdown file at `docs/delegation/briefs/<task>.md` on any `claude/*` branch —

```
# <Task title>

Target branch: `claude/<task>-<suffix>`

<free-form body>
```

`src/watcher/brief.ts` parses this. It is deliberately strict about the two structural lines (a leading `# Title`, a `Target branch:` line naming a `claude/...` branch) and rejects anything else with a specific error rather than guessing — PROTOCOL.md's "never invent results" rule applies to misreading a brief just as much as to fabricating a test count.

**A new read-only GitHub port**, `src/integrations/github/client.ts` (`listBranches`, `listDirectory`, `getFileContent`), with `FakeGitHubClient` for tests and `RealGitHubClient` calling the GitHub REST API directly via `fetch` — no octokit dependency, the same zero-runtime-deps discipline as the Inkbox and Sleeper real clients (ADR 0002, ADR 0006). It only reads. Nothing in this project's own code calls a GitHub write endpoint anywhere.

**The watcher's one write path is local `git`, not the GitHub API.** `pollForBriefs` (`src/watcher/brief-watcher.ts`) is pure orchestration over injected dependencies — a `GitHubClient`, a `SeenBriefStore`, and two callbacks (`checkoutBranch`, `recordPickup`) — so its tests (`brief-watcher.test.ts`) run entirely against `FakeGitHubClient` and scripted callbacks, never touching the network or a real working tree. The real callbacks are:

- `src/watcher/checkout.ts`: `git fetch` + `git checkout -B <target> <base>`, reusing an existing remote branch if one already exists rather than resetting it, otherwise branching fresh off `origin/main`. Tested with the same scripted-`GitRunner` pattern as `auto-commit.ts`.
- `src/watcher/delegation-log-stub.ts`: writes a starter `trial/delegation-log.md` (title, source brief, the brief's own body, and empty Diagnosis/Delegation-table/Budget-status headings for the next Code session to fill in) into the just-checked-out branch, then commits and pushes it with the existing `commitAndPush` helper (`src/integrations/git/auto-commit.ts`) — no new git-writing code path, the one this project already trusts.

**Deduping is content-addressed, not just path-addressed.** `SeenBriefStore` (`src/watcher/seen-store.ts`) keys on `branch::path::sha`, so editing a brief's content (new blob sha) is treated as a new pickup, but re-polling the same unchanged file is not. A checkout failure is deliberately left un-marked-seen (retried next poll — likely transient); a parse error is marked seen (retrying won't fix a malformed file on its own, and reporting the same error every three minutes would just be noise) but a *new* sha on that same path clears it automatically once the brief is fixed.

**No auto-merge, and no exception to any approval gate.** The watcher's entire effect on GitHub is: read some branches/files, and push one small stub commit onto the *target* branch the brief itself names — a branch nothing else was using yet, or one already mid-flight. It never touches `main`, never opens or merges a PR, and never runs the brief's instructions itself. "Surfacing the brief for execution" means exactly that stub commit: a working branch that exists, with the brief's own text and a starter log already on it, ready for whichever Code session (or human) picks it up next. PROTOCOL.md's merge-on-green-only rule and every existing approval gate are untouched because nothing here reaches them.

**The CLI**: `orchestrator watch-briefs poll` (one cycle, exit 0 if clean, 1 if any pickup or parse error needs attention) and `orchestrator watch-briefs loop [--interval-ms N]` (repeats `poll` every ~3 minutes by default, logging and continuing past a single failed cycle rather than crashing the process — PROTOCOL.md's "back off, don't hammer"). `GITHUB_TOKEN` (read-only content access) comes from the environment only, exactly like `INKBOX_API_KEY`; the CLI fails with a clear message rather than falling back to an unauthenticated, low-rate-limit client.

## Why not have the watcher actually execute the brief

An agent loop that reads a brief and starts editing code unattended has no approval gate before its first write — exactly the shape PROTOCOL.md's hard rules and ADR 0004's consequential-tools split exist to prevent. Keeping the watcher to detect → checkout → stub-and-push means a human or a dispatched Code session is still the one that reads the brief's actual instructions and decides what to do, on a branch that already exists and is already visible on GitHub the moment the watcher runs — the manual step removed is "notice the brief and create the branch," not "decide what to build."

## What "becoming the standing session" means given this environment

A single chat session cannot itself be a durable, always-on watcher: a cloud session's container is reclaimed after inactivity, and PROTOCOL.md's own budget caps a session at 45 minutes of wall time. The durable embodiment of "standing" here is a recurring trigger that re-invokes `orchestrator watch-briefs poll` on a schedule — a scheduled Claude Code session cron job at the ~3-minute cadence, or, for a machine that's on anyway, a `launchd`/cron entry running `npm run watch-briefs -- poll`, the same pattern ADR 0014's job-search pipeline already uses (`scripts/com.mobyai.jobsearch.plist`). Either way the unit of work per firing is a single bounded poll, not an open-ended session — see the bootstrap session's own report for which mechanism was actually armed and its known limits.

## What this does not do

- Does not open or merge a pull request.
- Does not run the brief's instructions, write code, or make any decision about *how* to do the work.
- Does not write to GitHub through its API — only reads.
- Does not require any new runtime dependency (`fetch`, `node:test`, `node:child_process` only).
