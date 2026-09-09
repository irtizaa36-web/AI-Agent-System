# Public.com monitoring and trade-drafting system

A standalone system that watches the Public.com brokerage account, reports what
the record shows, and — once a signal has cleared the evidence bar — drafts
trades for a human to approve.

**It cannot place an order.** Not "is configured not to": the client interface it
talks to the connector through (`src/tools/public-trading/client.ts`) exposes the
four read tools plus `preflight_order` and nothing else, with no generic
call-any-tool escape hatch. Adding execution would be a visible change to the
module's contract, which is what the repo's standing rule that reading and
drafting are separate from consequential execution (README safety principle 1,
ADR 0004, `docs/BIG-BOSS-HANDOFF.md`) is asking for.

## Relationship to the existing Public.com Agent

This is **not** a supervisor, wrapper, or modifier of the two Public.com Agents
in `docs/registry/PROJECT-REGISTRY.md` §8. Those keep running exactly as they
are. This system does not read their configuration, pause them, or attempt to
control them, and nothing in it has the ability to.

Why separate, from `BRIEFING.md`:

- Their decision logic is not visible over any API — only their outcomes are, via
  trade history. Bolting onto them could observe after the fact but not intervene
  before a bad trade, which defeats a draft-then-approve design.
- Two systems acting on the same capital makes buying power, sizing and
  concentration harder to reason about.
- Running both in parallel, tracked separately, gives a real comparison over the
  same weeks: their live, opaque trades against this system's validated, reviewed
  drafts. That comparison should inform whether the older agents are eventually
  wound down — not a priori reasoning, and not a decision to make now.

The two share one account, so this system's reports necessarily describe
positions and orders the other agents created. Where it does, it reports the
arithmetic and draws no conclusion about which agent did what — the review says
so explicitly.

## Current posture: monitoring only

Zero signals have cleared the backtest plus random-entry baseline bar in
`.agents/skills/crypto-signal-eval/SKILL.md`. Until one does, this system
monitors and reports; it does not propose trades.

That is enforced, not just documented: `src/tools/public-trading/signals.ts`
holds an empty `VALIDATED_SIGNALS` registry, and `proposeDrafts` returns nothing
while it is empty. Turning drafting on means adding an entry to that list, which
is a reviewable diff that has to state its evidence — and `validateSignalEvidence`
refuses evidence that fails the skill's own kill criteria (negative mean return
after costs, failing the random baseline, fewer than ~30 trades, a lone profitable
configuration in a sweep, no walk-forward validation, no stated mechanism, or a
zero-cost backtest).

Do not register the volume-expansion breakout. It was tested across 27
configurations on 365 daily DOT bars; all 27 lost money after costs, and it ranked
worse than 78% of 2000 random-entry draws. The skill records that as settled and
warns against resurrecting it by adding parameters.

## Cadence

**Daily**, via `coworker/triggers/public-trading-checkin.sh`.

The reasoning, since the alternative (every 4 hours) was considered: the signal
research and the backtest bar are both on daily bars; every number the review
reports — realised P/L, cost drag, concentration — is cumulative, and a single
`get_history` pull captures every trade regardless of when it runs. With no
validated signal there is nothing to time an entry against, so a 4-hourly cadence
would produce six times the files carrying the same information.

Revisit when a signal clears the bar and entry timing starts to matter.

## Where reviews live

`docs/operations/public-trading/YYYY-MM-DD.md`, one file per run, committed.

Continuity comes from the files themselves. Each review's YAML frontmatter carries
a `watermark` — the latest transaction timestamp that run accounted for — and the
next run reads the newest review's watermark to decide what "closed since last
run" means. There is no separate state file to drift out of sync.

A standing note on contents: a review holds account value, positions, buying power
and realised P/L, and this repository is public. That was a deliberate, confirmed
choice, made to keep the reviews durable and readable across sessions and clients.
If the repository's visibility assumptions change, this directory is the first
thing to revisit.

Each review contains:

1. **Portfolio snapshot** — account value, cash, buying power, equity by class.
2. **Closed-trade P/L since the last run** — FIFO-matched round trips with hold
   time, realised P/L, price move, and per-trade cost drag.
3. **Cost drag** — realised, dollar-weighted, against the 0.75% baseline.
4. **Concentration** — every position by share of account, with threshold flags.
5. **Open-order feasibility** — queued buys against available buying power.
6. **Drafted trades** — or, currently, why none were drafted.

## How a run works

The MCP connector lives in the Claude session, not in the Node process, so the
split is: the session calls the read tools and pipes their raw responses in; the
CLI does the analysis, watermark continuity and file writing deterministically.

```bash
# The session writes {"accountId", "portfolio", "history"} as JSON, then:
node dist/cli/index.js public-trading review --input run.json
```

That keeps every number in a review reproducible from a saved input, and keeps
connector credentials out of the Node process entirely.

## Gates a future draft must clear

When a validated signal exists, every candidate order passes four gates in order
(`src/tools/public-trading/draft.ts`):

1. **Validated signal** — the candidate's signal must be in the registry.
2. **Buying power** — the order's notional must fit inside `buyingPower`. This is
   the check the 2026-09-09 audit found missing: 16 buys totalling ~$57 were
   queued against $14.91 and most could not fill.
3. **Cost drag** — expected edge must survive the round-trip cost baseline. At
   these position sizes drag routinely exceeds the entire hypothetical edge.
4. **Preflight** — `preflight_order` validates the exact order against the broker.
   A rejection, or a buying-power requirement above what is available, kills it.

A draft that clears all four is written into the review with its reasoning and
preflight numbers. It is still only a draft: acting on it is a separate, explicit,
human step.

## Cost-drag baseline

`ROUND_TRIP_COST_BASELINE` is 0.75%, from `BRIEFING.md` — the SOL round trip moved
−1.1% in price but cost the position 1.75%.

Drag is measured per fill as the gap between `principalAmount` (gross at the
quoted execution price) and `netAmount` (cash that actually moved). That gap
appears even when the reported `fees` are `"0.00"`, because it is spread and
markup rather than a stated commission — which makes it exactly measurable rather
than inferred from price-move-versus-P/L.

The first live run (2026-09-09) measured **2.07%** dollar-weighted across five
closed round trips, well above the baseline, driven by a single AVAX sell that
gave up 2.45% on one leg. If that holds as the sample grows, the baseline used in
backtests should be revised upward: a signal has to clear the cost it actually
pays, not the cost that was assumed.

## Signal work

Price history never goes into an agent's context — a year of daily bars is large
and a month of hourly bars is larger. It goes to disk for `backtest.py` and
`baseline.py` to read, via `writePriceHistoryCsv` in
`src/tools/public-trading/price-history.ts`, which emits the
`date,open,high,low,close,volume` CSV those scripts expect. The review pipeline
deliberately never calls `get_price_history` at all.
