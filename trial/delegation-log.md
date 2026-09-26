# Delegation log: blocked-vs-quiet browser hardening (brief 2c)

Branch: `claude/browser-blocked-hardening-7n8giz`
PR: _see the PR opened from this branch_
Protocol: `docs/delegation/PROTOCOL.md` (added in this branch's first commit, Job 1)

The previous round's log (X search-intel fix, PR #56) is in git history on `main`.

## Diagnosis

PR #56 / ADR 0025 taught the X sweep to tell a blocked page from a quiet one.
The other browser Tools had the same blind spot. `read-web-page` and
`read-job-board-page` passed back whatever text loaded, so a blank or crashed
page looked to the agent like a page with nothing on it. The form tools filled
and clicked without checking that the page had loaded, and reported any
post-click page as `submitted:true`, even a blank one.

## Implemented

- `src/integrations/browser/page-health.ts`: `PageStatus`, `classifyPage`,
  `checkSessionHealth`, `CircuitBreaker` (per domain, trips at 3), `pace`/`Pacer`
  (default 4 s), `readWithOneRetry`. `sweep.ts` refactored onto it with no
  behavior change. The x-research tests are unchanged and pass.
- `BrowserClient.getPage` (optional, read-only): text, final URL, HTTP status.
  Implemented in the real and fake clients. No write capability added.
- `read-web-page`: `status:` line, one paced retry, then an explicit blocked or
  error report.
- `read-job-board-page`: the same, plus a base-URL health check per board, a
  per-board breaker, and `urls` for multi-board runs.
- `orchestrator browser health <site> <url>`: prints the status and exits 1
  unless the page is ok or empty.
- `HealthCheckedFormFillingClient` (wired in `loadDefaultConfig`): pre-fill
  health check, exactly one submit attempt, `unknown` outcome on an ambiguous
  result, and a per-domain breaker that blocks further submits. Approval gates
  are unchanged.
- ADR 0026 and a PROJECT-BRAIN.md entry.

## Tests

- Before: 867/867.
- After: `npm test` 895/895 passing, 0 failing (28 new). `tsc --noEmit` is clean.
- No live-account traffic was used. Everything was validated with
  `FakeBrowserClient` and `FakeFormFillingClient`.

## Delegation table

| Subtask | Disposition | Reasoning |
|---|---|---|
| Save PROTOCOL.md + CLAUDE.md pointer (Job 1) | Handled [STRUCTURE] | Exact text supplied; direct repo access; delegating adds only latency. |
| Extract page-health.ts, refactor sweep.ts | Handled [RUBRIC] | Core engineering; preserving sweep behavior exactly needed judgment (markers switched off for the sweep). |
| Classification rules (blocked vs empty) | Handled [RUBRIC] | Design tradeoff: false "empty" is the failure being fixed, so ambiguity maps to blocked. |
| Read tools, CLI health command | Handled [RUBRIC] | Core engineering and tests. |
| Form wrapper, no-retry-on-submit decision | Handled [RUBRIC] | Safety-critical design (duplicate-submit risk); recorded in ADR 0026. |
| Tests, `npm test`, `tsc` | Handled [STRUCTURE] | Direct shell access in session. |
| Delete stale branches (marketplace-agent-v2, voice-broker-real-email-gaps, karen-negotiation-upgrades) | Handled [STRUCTURE] | Verified 0 unmerged commits vs `main` first; git access is in-session. |

Nothing was delegated to Muse. No subtask needed Toozy's personal context,
credentials, or anything sent as him.

## Budget status (at write-up)

This session can't see its exact spend. Its work was one focused
implementation pass, estimated to be well under the $7.50 warning line of the
$15 promo cap. No weekly credits were knowingly used.

## Pending / integration-round items

- The next scheduled real job-board run and returns-autopilot run are the live
  validation. Watch for `status: blocked` and `submitted:unknown` in their
  output.
- Skills or agent instructions that parse `read-web-page` or
  `read-job-board-page` output should expect the leading `status:` line. The
  job-search pack consumes the text through the model, so no code change is
  needed.
