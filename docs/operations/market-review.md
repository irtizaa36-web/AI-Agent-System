# Market review — scheduled portfolio and options check-ins

Four check-ins per trading day that read the Public.com account, price a short
list of underlyings and option contracts, cross-check the day's catalysts, and
produce a ranked list of ideas — with a direction and a suggested size — for a
human to act on or ignore.

**It cannot place an order.** Not "is configured not to": the client interface it
talks to the connector through (`src/tools/market-review/client.ts`) exposes
`get_quotes`, `get_option_expirations`, `get_option_chain`, `get_option_greeks`
and `get_portfolio`, and nothing else. There is no `place_order` path, no
`cancel_order`, and deliberately not even `preflight_order` — this system never
proposes an order as an executable action, so it has no reason to validate one
against the broker. Adding execution would be a visible change to the module's
contract, which is what the repo's standing rule that reading and drafting are
separate from consequential execution (README safety principle 1, ADR 0004) is
asking for.

## Relationship to the other systems here

- **Not** a supervisor or modifier of the two Public.com Agents in
  `docs/registry/PROJECT-REGISTRY.md` §8. Those keep running as they are. This
  system does not read their configuration, pause them, or control them, and
  nothing in it has the ability to. It observes the same account they trade in,
  so its reports necessarily describe positions those agents opened; where they
  do, the report says so and draws no conclusion about which agent did what.
- **Separate from** the daily monitoring system in `docs/operations/public-trading.md`.
  That one answers "what did this account do, and what did it cost" once a day on
  cumulative numbers. This one answers "what is worth looking at right now" four
  times a day on live quotes. They share the `decimal.ts` helpers and the
  portfolio normaliser, and nothing else.
- **Applies** `.agents/skills/options-trading-eval/SKILL.md`. The evidence
  caveats this system attaches to a recommendation are that skill's settled
  findings, cited with their confidence labels.

## The one deliberate gap: sizing versus buying power

Suggested sizes are computed as `floor(riskBudget / premiumPerContract)` against
a risk budget stated per run. They are **not** checked against the account's live
buying power, by explicit operator decision made after the conflict was raised.

That is a real gap and it is not hidden: a suggested size can exceed what the
account could actually buy — buying power was $2.20 when this was built, while a
single SPY 0DTE contract runs $200–300. Every report therefore carries the
disclaimer verbatim, and the CLI repeats it on stdout after any run that produced
a recommendation. The disclaimer is the agreed mitigation, so it is not optional
and is not summarised away. Verify buying power before acting on a size.

## What each of the four slots is for

| Slot | ET | Question it answers |
|---|---|---|
| `pre-open` | 09:00 | What is scheduled today, what does the account hold into it, and which names are worth watching? Prices are pre-open reference values, not tradeable quotes. |
| `opening` | 09:35 | Did the pre-open read survive contact with a live market? Spreads are at their widest in these minutes. |
| `midday` | 12:00 | What changed since the open, and has anything invalidated the morning's reasoning? |
| `pre-close` | 15:30 | Anything expiring today resolves to intrinsic value in minutes. Decay and time remaining dominate. |

Each slot renders a different report — different sections, in a different order,
with different framing. The ordering is the reading order that makes sense at that
time of day: `pre-open` leads with catalysts because nothing has traded yet, while
`pre-close` leads with the clock because minutes remaining is the binding
constraint. Adding a slot means adding a row to `SLOT_PLAN` in `render.ts`, not
writing another renderer.

## Cadence and the timezone trap

Registered via `coworker/triggers/market-review-checkin.sh <slot>`, weekdays only.

**Cron runs in UTC; these are ET times.** ET is UTC-4 under EDT and UTC-5 under
EST, so a fixed UTC crontab is an hour wrong for part of the year. Use launchd's
`StartCalendarInterval` (which follows the machine's local zone) or put
`CRON_TZ=America/New_York` at the top of the crontab. The trigger script documents
both.

The check-in itself flags a run that fired far from its slot's target time
(`SLOT_TIME_DRIFT`) rather than reporting numbers from the wrong moment as though
they were on schedule — but that flag is a safety net, not the fix.

Market holidays are **not** excluded from the schedule. A holiday run fires,
finds no live market, and writes an explicit incomplete entry.

## How a run works

The MCP connector lives in the Claude session, not in the Node process, so the
split is: the session **fetches and judges**, the CLI **computes and records**.

```bash
node dist/cli/index.js market-review check-in --slot pre-close --input run.json
```

The session supplies raw connector responses plus its own theses. The CLI does
every derived number — breakeven, theta per contract, required moves, IV
comparisons, scores, sizes. That division is deliberate: if the session
pre-computed those figures, the maths would live in an agent's head instead of
under test, which is exactly the arrangement that produced a 100× theta error
once already (`.agents/skills/options-trading-eval/SKILL.md`, "Gotchas that
produce 100× errors").

### Input shape

```jsonc
{
  "runAt": "2026-09-16T19:30:00Z",         // optional; defaults to now
  "accountId": "5OI24720",
  "sizing": { "riskBudgetUsd": 250 },      // REQUIRED — the command will not invent one
  "portfolio": <raw get_portfolio result>,
  "vix":       <raw get_quotes result, instrument_type INDEX>,
  "underlyings": <raw get_quotes result for the stocks/ETFs priced this run>,
  "chains": [ <raw get_option_chain result>, ... ],
  "contracts": [                            // which contracts to analyse
    { "osiSymbol": "SPY260917C00754000", "entryPrice": 2.98 }  // entryPrice optional; defaults to the ask
  ],
  "ivTermCheck": { "near": "2026-09-17", "far": "2026-09-18" },  // both chains must be supplied
  "candidates": [ { "symbol": "SPY", "sources": ["WATCHLIST"], "note": "…" } ],
  "catalysts":  [ { "symbol": "MU", "kind": "EARNINGS", "date": "2026-09-18",
                    "tradingDaysAway": 2, "detail": "Q4 earnings, after close" } ],
  "theses": [                               // the session's own views
    {
      "symbol": "SPY",
      "direction": "BEARISH",               // BULLISH | BEARISH | NEUTRAL
      "conviction": "LOW",                  // LOW | MEDIUM | HIGH
      "mechanism": "…why this should pay…",  // REQUIRED, and must be causal
      "sources": ["…"],
      "osiSymbol": "SPY260917P00754000"     // which analysed contract this view is about
    }
  ],
  "notes": ["Checked Zacks news and a web search for Fed commentary at 09:52 ET."],
  "incomplete": { "reason": "…", "details": ["…"] }   // set instead of guessing
}
```

A thesis with an empty `mechanism` is **rejected**, not rendered blank. A
recommendation whose reasoning field is empty is what this repo's evidence rules
exist to prevent, so it fails at build time instead of producing a report that
looks complete and says nothing.

### Closing the loop

Marking to market is a separate command, because "at the close" is not the only
question worth asking and a 0DTE contract at 15:30 is a different number from the
same contract at 16:00:

```bash
node dist/cli/index.js market-review close-loop --input outcomes.json
```

Every outcome must name its reference moment (`asOf` plus a human
`referenceLabel`). A mark with no reference time is not a mark, and the command
refuses it.

```bash
node dist/cli/index.js market-review log --limit 20   # prediction + outcome rows
```

## Where things live

| Path | What |
|---|---|
| `docs/operations/market-review/YYYY-MM-DD-<slot>.md` | One report per run, committed |
| `docs/operations/market-review/prediction-log.jsonl` | Append-only prediction + outcome log |
| `config/market-review-watchlist.json` | The curated watchlist — edit directly, nothing generates it |

Reports are Markdown because they are for reading. The log is JSONL because
accuracy-over-weeks is a tabular question, and because append-only means a row
can gain an outcome later but nothing rewrites history.

The same visibility note as the sibling system applies: these files record
account value, positions and suggested sizes, and this repository is public. That
was a deliberate choice for durability across sessions and clients. If the
repository's visibility assumptions change, these directories are the first thing
to revisit.

## Candidate sources

Three sources merge, and a name keeps every source that surfaced it — "both a
holding and today's biggest mover" is the interesting case:

1. **Holdings** from `get_portfolio`. Option positions are skipped, since the
   catalyst and quote work needs the underlying.
2. **The curated watchlist**, reviewed every run regardless of holdings.
3. **Market scan** hits the session supplies (movers, unusual volume, earnings
   reactions).

Chain pulls are the expensive call, so only the watchlist's `optionUnderlyings`
list gets one. With no list configured, no chains are pulled at all — the
underlyings whose options matter are a deliberate choice, not a side effect of
holding a stock.

`minPortfolioWeight` bounds the catalyst work as the position count grows. It only
ever drops *holdings* below that weight; a watchlist or scan name has no weight to
compare and is never dropped for lacking one.

## Data-quality guards, and why each exists

Every one of these fires on real observed data, not a hypothetical:

| Flag | Severity | Why |
|---|---|---|
| `PREMARKET_QUOTE` | BLOCK | A quote before 09:30 ET carries the prior close and corrupts every derived Greek. Corrupted an earlier manual run. |
| `ZERO_BID` | BLOCK | Nothing to sell into: the position could not be exited at any price, whatever the mid implies. Seen on live IOVA strikes. |
| `SEVERE_SPREAD` | BLOCK | Spread ≥25% of mid. The real IOVA $12.50 call quoted 0.10/0.30 — a 100%-of-mid spread. |
| `WIDE_SPREAD` | WARN | Spread ≥5% of mid, the liquidity threshold. |
| `IV_ARTIFACT` | WARN | Deep-ITM strikes report `impliedVolatility: 0` beside `delta: ±1`. A pricing artifact, excluded from IV comparisons rather than averaged in. |
| `IV_TERM_ANOMALY` | WARN | Same-strike IV differing >2× across adjacent expirations is usually a data artifact, not a term-structure move. |
| `STALE_QUOTE` | WARN | Quote older than an hour at run time. |
| `NO_OPEN_INTEREST` / `NO_VOLUME` | WARN | No established market; `last` carries no current information. |
| `MID_DISAGREEMENT` | INFO | Vendor mid differs from `(bid+ask)/2` by more than two cents. Ordinary rounding does not fire it. |
| `SLOT_TIME_DRIFT` | WARN | The run fired >20 min from its slot's target — usually a UTC cron that missed a DST change. |
| `NON_TRADING_DAY` | BLOCK | Weekend run. No live market. |

Bad data is flagged, never silently repaired. Nothing substitutes a plausible
number for a missing one, because a plausible wrong number is worse than a
visible gap.

## What the score is, and is not

A recommendation's score starts at a neutral 100 and takes **penalties only**,
each for something measurable: spread as a share of mid, theta as a share of
premium, the size of the move breakeven requires, a blocking data problem, and
proximity to an earnings print.

A high score means "the mechanics of this contract are least likely to work
against you." It does **not** mean the idea will pay. Nothing in the score
predicts anything — the direction is always an input from the session, never a
derivation.

Conviction is recorded but deliberately does not move the score. It is the
caller's confidence, not evidence.

Earnings proximity is a **penalty**, not a highlight. Buying a long option into a
known catalyst is the single worst documented case for retail
[VERIFIED — de Silva/So/Smith: 5–9% average loss, worsening to 10–14% where
expected volatility is highest], so a catalyst in the window counts against a
premium-buying idea rather than for it. That inversion is the point.

## External signal tracking (unverified sources)

A separate, explicit capability for tracking a named third-party source's stated
market calls — a YouTube channel, say — and grading them against what actually
happened. This exists because a request to import such a channel's videos
directly into the evidence-based skill would reverse
`.agents/skills/options-trading-eval/SKILL.md`'s founding decision: popularity
and confidence are not evidence, and at least one of the most-repeated claims in
retail options education is directly contradicted by peer-reviewed work. See
`docs/research/options-trading-evidence-2026-09.md`'s 2026-09-17 addendum for
the full reasoning.

**What this is:** a record of what a source said, timestamped before the
outcome was known, graded afterward on direction only.

**What this is not:** evidence, a recommendation, or content for the skill. A
tracked source's calls are never cited as support for a trading claim. If a
source's hit rate is ever large-sample and strong enough to be worth citing,
that citation would describe *that source's track record specifically* — a
[FIRST-PARTY] finding with its own sample-size caveats — never a general
options-trading truth.

```bash
# Record a call, before the outcome is known.
node dist/cli/index.js market-review external-signal add --input signal.json

# Record what actually happened, once it's known.
node dist/cli/index.js market-review external-signal outcome --input outcome.json

# See the hit rate.
node dist/cli/index.js market-review external-signal stats
```

`add` input:

```jsonc
{
  "signals": [
    {
      "sourceName": "Some Channel",
      "sourceUrl": "https://www.youtube.com/@SomeChannel",
      "videoUrl": "https://www.youtube.com/watch?v=...",
      "videoTitle": "...",
      "recordedAt": "2026-09-17T14:00:00Z",
      "forDate": "2026-09-17",
      "symbol": "SPY",
      "direction": "BEARISH",              // BULLISH | BEARISH | NEUTRAL
      "statedThesis": "…what they actually said, quoted or faithfully summarised…"
    }
  ]
}
```

`statedThesis` is required and rejected if empty, for the same reason a
recommendation's `mechanism` is required: a graded call with no record of what
was claimed cannot be audited later. **Never fill this field from a title or a
paraphrase you are not confident in** — if the actual claim could not be
obtained (a blocked transcript, for instance), say so explicitly in the field
rather than inferring a direction from framing. "Trap" language especially is
built to be unfalsifiable after the fact; grading only the raw direction is
what keeps this honest.

`outcome` input mirrors `close-loop`: every entry needs `asOf` and a
`referenceLabel`, plus `priceAtCall` (without it the call is recorded but stays
`UNGRADED` forever) and `priceAtReference`.

A `NEUTRAL` call is recorded but never graded — there is no principled
threshold for "the market went nowhere" that couldn't be tuned after the fact
to make a source look better.

Stored separately from this system's own predictions, at
`docs/operations/market-review/external-signals.jsonl` — never merged into
`prediction-log.jsonl`, so a reader never has to wonder row by row whether an
entry is this system's own recommendation or a third party's.

## Known limitations

- **No market-wide forward earnings calendar** is available through any connector
  here — Twelve_Data's earnings endpoint takes one symbol and returns that
  symbol's history, and the calendar-wide endpoints are plan-gated. Catalysts are
  therefore per-ticker lookups, and an absence of found events is not a guarantee
  of a quiet window. The reports say so explicitly.
- **Market holidays are not in the data.** Weekends are detectable from a
  timestamp; holidays are not. A holiday run writes an incomplete entry.
- **Macro event odds** (a Fed hike probability, say) come from live news and web
  search each run, not a feed. Nothing is cached, so a stale prior-day estimate
  cannot be carried forward — but the quality is whatever the search returned.
- **Very large chains are untested at scale.** SPY lists hundreds of strikes
  across 30+ expirations; the smoke test used a handful of real contracts rather
  than a full chain. Narrow to strikes near spot (`strikesNearSpot`) before
  pulling a full SPY chain into a session's context.
