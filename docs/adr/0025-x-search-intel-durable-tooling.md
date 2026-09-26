---
status: accepted
---

# X Search Intel: durable tooling with a session health check, blocked-page detection, and a circuit breaker

## The failure this replaces

The X Search Intel skill's original method was a single ad hoc step: "spawn a
browser task signed in as @WoozyBets and visit
`https://x.com/search?q=<query>&src=typed_query&f=live` per topic." On
2026-09-26, the last two runs of the day came back with zero posts across
every topic — search pages "stopped loading / crashed to blank pages." Earlier
the same morning (~09:00) a sweep partially worked (six of eight topics had
posts). Between those two points, a follow burst (15 follows, ~08:48–08:52)
triggered a soft account throttle.

That timeline — healthy, then a write burst, then a soft throttle, then total
search failure — points at the account/session itself going into a
blocked/challenge state that affects page loads generally, not a change to
the search URL, the `f=live` parameter, or a one-off page crash. Three things
made the original method blind to this:

1. **No session health check.** Every topic was visited independently with no
   cheaper, earlier signal for "is this session even working right now."
   Once the account was throttled, the sweep still spent all eight topic
   visits finding that out the hard way, one blank page at a time.
2. **No blocked-vs-quiet distinction.** A blank/crashed page and a topic that
   legitimately has no news look identical to a method that just reads
   whatever text comes back. The skill's own rule ("if a topic has no real
   news, say so — never pad") only works if a block is never mistaken for
   quiet in the first place.
3. **No backoff, no fallback, no circuit breaker.** A blank result was a dead
   end, and nothing paced the requests or stopped early once several topics
   in a row were clearly failing the same way — the opposite of what you'd
   want while an account is already being throttled.

## The fix

`src/integrations/x-research/sweep.ts` (`runXSearchSweep`) adds the missing
layer on top of the existing `BrowserClient` port (ADR 0007) — no change to
that port's read-only, single-method contract:

1. **Pre-flight health check.** Before touching any topic, it reads a
   lightweight authenticated page (`x.com/home`). A blank/near-empty result or
   a thrown error there means the session itself is the problem, and the
   sweep stops immediately with one clear `sessionHealthy: false` note per
   topic, rather than burning eight more requests (and further stressing an
   already-throttled account) to rediscover the same fact.
2. **Blocked vs. quiet, kept distinct.** A page's rendered text below a
   minimum length threshold is treated as blocked/blank, not as "no real
   news" — that distinction is visible in each topic's `status` (`"ok"` |
   `"blocked"` | `"skipped"`) so the report downstream never pads a block as
   quiet.
3. **One fallback per topic.** A blocked Latest-tab (`f=live`) result gets one
   retry on the Top tab (same query, no `f=live`) after a pause. The Top tab
   serves cached, already-ranked results rather than the continuously-polling
   live stream, so it's a meaningfully different request, not just a retry of
   the same thing.
4. **A circuit breaker.** Three consecutive blocked topics stop the sweep from
   attempting the rest — the remaining topics are marked `"skipped"` with a
   note explaining why, instead of the sweep continuing to hammer a session
   that's evidently still blocked.
5. **Enforced pacing.** A delay runs between topics and before each fallback
   retry, so the sweep itself reads as ordinary browsing cadence rather than
   the kind of rapid-fire requests that plausibly contributed to the original
   throttle.

`src/tools/x-search-sweep.ts` exposes this as a Tool (`x-search-sweep`),
registered in `loadDefaultConfig` (via the new `LoadOptions.xBrowserClient`,
following the existing "optional deps as one named bag" pattern rather than
growing the function's positional parameter list) against
`createDefaultBrowserClient("x")` — the same real-session/fake-fallback
pattern every other site already uses (ADR 0007), reusing the already
site-agnostic `browser login <site> <url>` command with `site = "x"`. `x
search-sweep` (`src/cli/x-commands.ts`) exposes the same sweep directly from
the CLI and exits non-zero when the session health check fails, so a caller
notices without having to parse the report.

## What was verified, and what wasn't

Every code path above (health check pass/fail, per-topic fallback recovery,
blocked-vs-skipped distinction, circuit breaker, counter reset on recovery)
is covered by tests against `FakeBrowserClient` fixtures
(`src/integrations/x-research/sweep.test.ts`,
`src/tools/x-search-sweep.test.ts`, `src/cli/x-commands.test.ts`). None of
this was run against the live @WoozyBets session: the account was already
under a soft throttle at the time of this fix, and deliberately not touched
further to validate it — running more automated traffic against a
just-throttled account to test a fix for throttling would be the wrong move.
The next real sweep is the actual validation; if it still comes back
`sessionHealthy: false`, that is itself new, useful information (the block
outlasted the follow-burst throttle window) rather than a sign this fix did
nothing.

## What this doesn't change

- No write capability was added. `BrowserClient` still has exactly one
  method, `getPageText(url)` (ADR 0007) — this Tool has no way to like,
  reply, repost, follow, or DM, structurally, the same guarantee every other
  Tool built on this port has.
- No credential or session-storage change. Login is still the existing
  one-time, human-driven `browser login` flow; nothing here touches how the
  @WoozyBets session is authenticated or stored.
- The standing topic list and per-topic query intent are unchanged
  (`src/integrations/x-research/topics.ts`) — this ADR is about making the
  *fetch* durable, not about what's searched for.
