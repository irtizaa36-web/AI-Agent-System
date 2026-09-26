# Delegation log — X search-intel fix (round 1)

Branch: `claude/x-search-intel-fix-amzqp7`
PR: https://github.com/irtizaa36-web/AI-Agent-System/pull/56

## Diagnosis

Timeline rules out the `f=live` parameter or a URL-format change as the root
cause — the same query shape worked partially at ~09:00 the same morning. What
changed in between was a 15-follow burst (~08:48–08:52) that triggered a soft
account throttle. The next two sweeps came back with zero posts across every
topic — consistent with that throttle/bot-detection state affecting page
loads generally, not a per-topic issue. The skill had no way to tell "session
is blocked" from "topic is quiet," so it couldn't have caught this even once
it started happening.

## Fix implemented (this repo)

- `src/integrations/x-research/` (`runXSearchSweep`): pre-flight session
  health check, blocked-vs-quiet status distinction, one Top-tab fallback
  retry per topic, a circuit breaker after 3 consecutive blocked topics,
  paced requests between topics.
- `src/tools/x-search-sweep.ts` — Tool wrapper, registered in
  `loadDefaultConfig` via `LoadOptions.xBrowserClient`.
- `src/cli/x-commands.ts` — `orchestrator x search-sweep`.
- `docs/adr/0025-x-search-intel-durable-tooling.md` — full root-cause writeup
  and design rationale.
- `PROJECT-BRAIN.md` updated to reflect the new tooling.
- Tests: 867/867 passing (`npm test`, 12 new tests). `tsc --noEmit` clean.
- No write capability added or exists (`BrowserClient` still has exactly one
  method, `getPageText`). No credential or session-storage change.
- Not validated against the live @WoozyBets session — it was already
  soft-throttled; running more automated traffic against it to test a
  throttling fix would be the wrong move. The next scheduled sweep is the
  real validation.

## Delegation log

| Subtask | Disposition | Reasoning |
|---|---|---|
| Root-cause diagnosis | Handled [RUBRIC] | Weighing timeline evidence against candidate causes — judgment call. |
| Solution design (health check, fallback, circuit breaker) | Handled [RUBRIC] | Novel design decision with architectural tradeoffs (ADR territory). |
| Repo implementation + tests | Handled [RUBRIC] | Core engineering; needed tight integration with existing ADR 0007 patterns. |
| Running `npm ci`/`npm test`/fixing one broken snapshot assertion | Handled [STRUCTURE] | Direct Bash access in this session; round-tripping a <10s command would only add async latency. |
| Workspace skill file patch (X Search Intel skill, lives outside this repo) | **Delegated to Muse** | Mechanical application of an exact, already-authored patch to a file this session can't reach. |

### Delegated subtask detail — workspace skill patch

- **Input:** exact replacement body for the "X Search Intel" workspace skill
  (full text below).
- **Output:** the X Search Intel skill's content updated to that text.
- **Success criteria:** the Method section no longer describes a raw ad hoc
  "spawn a browser task" as the primary path; standing topics and the
  read-only rule (never like/reply/repost/follow/DM) are preserved verbatim;
  the post-write-burst cool-down rule is present.

```markdown
# X Search Intel

Run topic searches on X through the logged-in @WoozyBets browser session and report back the latest posts and news. Read-only: never like, reply, repost, follow, or DM.

Standing topics: NFL betting, college football betting, NBA, UFC/MMA, soccer, tech/AI, stocks, Houston.

## Method (updated 2026-09-26 — see AI-Agent-System ADR 0025)

Run the sweep through the AI-Agent-System repo's tooling instead of spawning a raw ad hoc browser task per topic: `orchestrator x search-sweep` (from the repo root, session `x` — run `orchestrator browser login x https://x.com/login` once if no session is saved yet for @WoozyBets).

That command already:
- runs a pre-flight health check on the @WoozyBets session before touching any topic;
- visits `https://x.com/search?q=<query>&src=typed_query&f=live` (Latest tab) per topic;
- retries once on the Top tab (same query, no `f=live`) if the Latest tab comes back blank or crashes;
- marks a topic `blocked` (not "quiet") if both tabs come back blank — never reports a block as "no real news";
- stops early after three consecutive blocked topics instead of continuing to hammer a throttled session;
- paces requests with a delay between topics and before each fallback retry.

If `orchestrator x search-sweep` isn't runnable in this environment (no repo access), fall back to the original method — spawn a browser task signed in as @WoozyBets, visit the same search URL per topic — but apply the same rules by hand: check a lightweight page (e.g. the home timeline) first if a topic comes back blank, treat a blank/crashed page as "blocked" and say so explicitly rather than folding it into "no real news," and stop the sweep early if several topics in a row are blank rather than working through the full topic list.

Capture 3-5 top posts per topic: author @handle, text (~200 chars), time, engagement if visible, post URL. Skip ads, crypto shills, giveaway spam. If a topic has no real news, say so — never pad. If a topic (or the whole sweep) is `blocked`, say that plainly instead — a block is not the same as "no real news," and reporting it as quiet hides a session problem that needs fixing before the next sweep.

## Cool-down after write activity

Do not run this sweep immediately after any burst of write actions on the @WoozyBets account (follows, likes, replies, posts) — space it out by at least 15-20 minutes. A write burst is the most likely trigger for the kind of soft account throttle that makes search pages start crashing; running a read-heavy sweep right on top of one adds to whatever's already elevated the account's risk signals instead of giving it a chance to cool down.
```

## Budget / time status

Within the $15 promo cap and the 45-minute wall-time budget as of this
write-up; the trial cap has not been approached. No SMS/email sent, no
credential changes, no settings changes. The @WoozyBets account was not
touched further.

## Integration round 2 (pending)

Waiting on: CI on PR #56 (subscribed; will merge only when green, per the
standing rule), and confirmation that the workspace skill patch above has
been applied. Once both land, this file will be updated with the final
outcome and test counts.
