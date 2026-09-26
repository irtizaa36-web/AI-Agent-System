# Delegation log: orchestrator brief watcher bootstrap

Branch: `claude/orchestrator-watcher-bootstrap-15bzcz`
PR: _see the PR opened from this branch_
Protocol: `docs/delegation/PROTOCOL.md`

The previous round's log (blocked-vs-quiet browser hardening) is in git
history on `main`.

## Diagnosis

The Orchestrator had a dispatch mechanism (task briefs) with no watcher on
the Code-session side to notice them — Muse's watcher already polls GitHub
for `trial/delegation-log.md` on `claude/*` branches, but nothing did the
equivalent for a new brief file. A human had to notice a brief and start a
Code session by hand. This session's job was to build that watcher, define
the brief format it reads, and then stand the watcher up.

## Implemented

- **Brief format** (`docs/delegation/briefs/<task>.md` on any `claude/*`
  branch: `# Title` / `` Target branch: `claude/...` `` / free-form body),
  parsed by `src/watcher/brief.ts` — strict about the two structural lines,
  a specific error for anything else.
- **Read-only GitHub port** (`src/integrations/github/client.ts`):
  `listBranches`, `listDirectory`, `getFileContent`. `FakeGitHubClient` for
  tests; `RealGitHubClient` calls the GitHub REST API directly via `fetch`
  (no octokit dependency, ADR 0002's zero-runtime-deps rule).
- **Poll orchestration** (`src/watcher/brief-watcher.ts`): lists `claude/*`
  branches, lists each one's `docs/delegation/briefs/`, parses new (by
  content sha) `.md` files, checks out the named target branch, and writes
  a starter `trial/delegation-log.md` there. One bad branch or malformed
  brief never stops the rest of the poll.
- **Local-git write path only**: `src/watcher/checkout.ts` (fetch + checkout
  a branch, reusing one that already exists remotely) and
  `src/watcher/delegation-log-stub.ts` (writes the stub, commits and pushes
  it via the existing `commitAndPush` helper — no new git-writing code).
  Nothing calls a GitHub write endpoint anywhere.
- **Dedup**: `src/watcher/seen-store.ts`, keyed on `branch::path::sha` so an
  edited brief is picked up again but an unchanged one isn't re-processed.
  A checkout failure is left unseen (retried next poll); a parse error is
  seen (won't fix itself) but clears automatically once the sha changes.
- **CLI**: `orchestrator watch-briefs poll` (one cycle) and
  `orchestrator watch-briefs loop [--interval-ms N]` (repeats every ~3
  minutes by default, logging and continuing past a failed cycle).
  `GITHUB_TOKEN` read from the environment only; a clear error if unset.
- ADR 0027, PROJECT-BRAIN.md (Section 3 entry; Section 11's "not being
  built" list narrowed — GitHub integration now has the one read-only slice
  this needed, nothing more), PROTOCOL.md (brief format documented),
  `docs/operations/local-operations.md`, `.env.example`, and
  `scripts/com.mobyai.watchbriefs.plist` (the machine-hosted, always-on
  counterpart to a chat session, same pattern as the job-search pipeline's
  own plist).

## Tests

- Before: 895/895.
- After: `npm test` 947/947 passing, 0 failing (52 new). `tsc --noEmit`
  clean. No live GitHub API traffic in any test — every GitHub-facing test
  uses `FakeGitHubClient` or a stubbed `fetch`; every git-facing test uses a
  scripted `GitRunner`, never real git.

## Delegation table

| Subtask | Disposition | Reasoning |
|---|---|---|
| Brief format design + parser | Handled [RUBRIC] | Format design is a real product decision (what the Orchestrator writes, what the watcher must never misread); needed judgment, not just typing. |
| GitHub client port (fake + real) | Handled [RUBRIC] | New integration boundary; deciding the read-only surface and how errors/pagination behave needed engineering judgment. |
| Poll orchestration, dedup, checkout, delegation-log stub | Handled [RUBRIC] | Core engineering — the actual watcher logic and its safety properties (no auto-merge, no API writes). |
| CLI wiring, `.env.example`, plist | Handled [STRUCTURE] | Mechanical, direct repo access, delegating would only add latency. |
| ADR + PROJECT-BRAIN.md + PROTOCOL.md updates | Handled [RUBRIC] | Recording an architectural decision and updating what's "not being built" needed judgment about scope, not just transcription. |
| `npm ci` / `npm test` / `tsc --noEmit` | Handled [STRUCTURE] | Direct shell access in session. |

Nothing was delegated to Muse. Nothing here needed Toozy's personal
context, credentials, or anything sent as him.

## Budget status (at write-up)

This session can't see its exact dollar spend. One focused implementation
pass (client + watcher + CLI + tests + docs), estimated well under the
$7.50 warning line of the $15 promo cap. No weekly credits knowingly used.
Wall time is being watched against the 45-minute budget; see the PR/report
for whether Part 2 (standing the watcher up) fit inside it or was handed
off as a follow-up.

## Pending / integration-round items

- **A genuinely 24/7 "standing session" isn't possible as a literal open
  chat session** — this environment reclaims idle cloud containers, and
  PROTOCOL.md's own budget caps a session at 45 minutes. See ADR 0027's
  closing section and this session's final report for what was actually
  armed (a recurring scheduled trigger and/or the plist for a
  always-on machine) and its known limits (a session-scoped scheduler
  auto-expires after 7 days; the plist needs a machine that's on and a
  `GITHUB_TOKEN` in its `.env`).
- The watcher's real-world behavior against a live `claude/*` branch with an
  actual brief file hasn't been exercised yet — only `FakeGitHubClient` and
  stubbed-`fetch` tests. The first live poll (once `GITHUB_TOKEN` is
  configured wherever this runs) is the real validation.
- No GitHub write path (PR creation, issue/comment writing, merging) was
  built — deliberately out of scope for this brief; see ADR 0027's "what
  this does not do".
