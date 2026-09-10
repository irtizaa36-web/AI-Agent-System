---
name: crypto-signal-eval
description: Evaluate a proposed crypto entry signal against historical data before it touches real money, and audit an existing trading agent's realized behavior. Use when the user proposes a trading trigger, asks whether a setup is worth acting on, or wants to review how their automated trading is actually performing. Produces draft recommendations only — never places orders.
---

# Crypto signal evaluation

## Prime directive

This skill **drafts and evaluates**. It does not execute. Order placement
requires the user's specific authorization for the exact order — symbol,
size, price, and stop — matching the repo's standing rule that reading and
drafting are separate from consequential execution.

If a signal has not been backtested, say so and refuse to score it. An
unvalidated trigger is a hypothesis, not a signal.

## The base rate you are arguing against

Every proposed signal starts from a strong prior of "no edge." The
literature is consistent across markets and decades:

- Barber and Odean, Taiwan, ~360k day traders: over 80% lose money;
  under 1% are reliably profitable after fees.
- Chague et al., Brazilian equity futures: 97% of those who persisted
  past 300 days lost money.
- FINRA (2020): ~72% of day traders ended the year down.
- The consistent mechanism in the loser cohort: overtrading, oversized
  losers, undersized winners, and transaction costs quietly consuming
  30-40% of gross gains.

This is not a reason to refuse the work. It is the prior that the
evidence has to overcome, and it means the default answer to "is this
signal good?" is no until a backtest says otherwise.

## Findings already established (do not re-derive)

**Volume-spike breakout as a short-squeeze proxy: tested, no edge.**

Tested on DOT, 365 daily bars (Sept 2025 - Sept 2026), 27 parameter
configurations spanning 10/20/30-day breakout lookbacks, 1.5x/2x/3x
volume multiples, 3/5/10-day holds, 8% stop, 0.75% round-trip cost.

- Every one of the 27 configs had a negative mean return per trade.
- Best config (30-day, 3x vol, 3-day hold): -0.7% total on 3 trades.
- Representative config (20-day, 2x vol, 5-day hold): 6 trades,
  17% win rate, -5.0% mean, -27.4% total, -30.7% max drawdown.
- Against 2000 random-entry draws with identical exit rules, the signal
  ranked worse than 78% of them. It is not distinguishable from noise.
- Four of six trades stopped out at the 8% floor. The one winner was
  the in-progress Sept 7 entry, which is not yet a closed result.

The uniformity of the negative result across all 27 configs is the
strongest part of this finding. A signal with a real edge that is
merely mis-tuned shows a profitable pocket somewhere in the grid.
This shows none.

**Do not resurrect this signal by adding parameters.** Searching harder
over the same 365 bars for a config that prints positive is textbook
p-hacking, and with 6 trades per config there is no statistical room
for it.

## Why the price-only version was always weak

A short squeeze is caused by crowded short positioning being forced to
cover. The positioning is the cause; the price spike is the effect.

Price and volume data contain only the effect, and only after it has
started. By the time a volume-expansion breakout is visible on a chart,
the covering is underway and the move is substantially priced in. That
is the mechanism behind the backtest result, and it is why the finding
should generalize beyond DOT.

The actual precondition variables are:

- **Funding rate.** On perpetual futures, funding is a periodic payment
  between longs and shorts that anchors the perp price to spot. Positive
  means longs pay shorts; negative means shorts pay longs. Most venues
  settle every 8 hours, some every 1 or 4. Deeply negative funding means
  the short side is crowded and paying to stay there.
- **Open interest.** Rising OI while price is flat or drifting down
  suggests shorts accumulating rather than longs.
- **Liquidation clusters.** Where stacked short liquidations sit above
  current price; price entering a cluster is what turns covering into a
  cascade.

None of these are available through the Public MCP connector, which
returns OHLCV only. **Any squeeze-anticipation signal built on Public
data alone is missing its causal variable.** Say this plainly rather
than substituting a price proxy and calling it a squeeze signal.

## Procedure

When the user proposes a signal:

1. **State the mechanism first.** What is the causal story for why this
   should predict returns? If the answer only references backtest
   results, that is a red flag for overfitting — the hypothesis should
   stand on economic reasoning before it is tested.
2. **Check the data actually contains the causal variable.** If not,
   stop and say so. Do not silently substitute a proxy.
3. **Backtest with realistic costs.** Use `backtest.py`. Default
   round-trip cost 0.75%, calibrated from the user's own realized
   slippage on Public (their SOL round trip lost 1.75% of position on a
   1.1% price move). Never backtest at zero cost.
4. **Sweep a parameter grid, and report the whole grid.** A single
   profitable config among many losers is a selection artifact. Report
   how many configs were positive, not just the best one.
5. **Run the random-entry baseline.** Use `baseline.py`. A signal that
   does not beat random entries with the same exit rules has no edge,
   regardless of whether its raw return is positive.
6. **Report honestly, including nulls.** A negative result is a useful
   result — it is money not lost. Do not soften it.

## Interpreting results

Kill the signal if any of these hold:

- Mean return per trade is negative after costs.
- It fails to beat the random-entry baseline.
- Fewer than ~30 trades (too few to distinguish skill from luck; the
  DOT test had 6 and that is stated as a limitation, not a result).
- Returns collapse when a parameter moves one notch — fragility means
  the config was fit to noise.
- Profitability is concentrated in one or two trades.

If a signal survives all of that, it is still a candidate, not a
conclusion. The next step is walk-forward validation on data the
parameters were not chosen on, not live deployment.

## Auditing a live agent

Separate from signal evaluation, and often more valuable, because it
uses realized rather than hypothetical data.

Pull `public:get_history`, then compute:

- **Closed round trips** with realized P/L per trade.
- **Cost drag.** Compare each trade's price move to its P/L move. The
  gap is spread and slippage. On the user's account this ran roughly
  0.6-0.75% per round trip, which on sub-$50 positions can exceed the
  signal's entire expected edge.
- **Hold-time distribution.** Clustered exit times suggest a time-based
  rule; exits clustered at a fixed loss suggest a stop.
- **Order feasibility.** Compare queued limit orders against
  `buyingPower` from `public:get_portfolio`. Orders exceeding available
  cash cannot fill, and an agent that re-queues them daily without
  registering the failures has a broken feedback loop.
- **Concentration.** Position value as a share of `totalAccountValue`.

Report what the record shows. Do not infer the agent's rules and then
evaluate the inference as if it were the rules — if the configuration
is not visible, say the configuration is not visible.

## Files

- `backtest.py` — signal generation, trade simulation with stops and
  costs, parameter sweep. Expects CSV: date,open,high,low,close,volume.
- `baseline.py` — random-entry comparison. Run this every time.
- `fetch_data.py` — pull OHLCV from Public into the CSV format.

## Token efficiency

The expensive parts of this work are pulling price history into context
and re-deriving settled findings. Avoid both:

- **Never read price history into context.** `public:get_price_history`
  for a year of daily bars is large and for a month of hourly bars is
  larger. Write it to disk with `fetch_data.py` and let the scripts read
  the file. Load only the summary table into context.
- **The volume-breakout finding is settled.** Cite the section above.
  Do not re-run that grid.
- **Read this file, not the conversation that produced it.** The
  research, the 27-config sweep, and the baseline test are compressed
  here on purpose.
- **Report the summary table, not trade lists**, unless the user asks
  for specific trades.
