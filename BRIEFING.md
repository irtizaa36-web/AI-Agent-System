# Public.com trading agent — audit briefing (2026-09-09)

Context gathered in a prior Claude chat session, before this build starts.
Read this so you don't have to re-derive it.

## Current state of the Public.com Agent

Two automated crypto trading agents built as Public.com Agents (browser-only
UI, no API access to their internal logic — see PROJECT-REGISTRY.md §8).
User confirmed the current live parameters were explicitly authorized.

## Realized trade record (as of 2026-09-09 ~06:00 UTC)

Closed round trips, all crypto, all within 48 hours:

| Symbol | Buy | Sell | Held | Net P/L |
|---|---|---|---|---|
| SOL | $8.00 | $7.86 | ~3 hrs | -$0.14 |
| BTC #1 | $40.24 | $39.58 | ~30 min | -$0.66 |
| ETH #1 | $30.18 | $29.61 | ~6 hrs | -$0.57 |
| BTC #2 | $2.01 | $1.98 | ~15 min | -$0.03 |
| AVAX (partial) | ~$66.90 | $67.31 | multi-day | +$0.41 |

4 losses, 1 small win. Net roughly -$1.00 on closed positions.

**Cost drag observed:** the SOL trade moved -1.1% in price but the position
lost 1.75% — the gap (~0.65 points) is spread/slippage. This is the basis
for the 0.75% round-trip cost assumption used throughout the backtest
skill. Confirm or refine this number once more closed trades accumulate.

**Order feasibility issue found:** at time of audit, 16 open limit buy
orders totaling ~$57 notional were queued against $14.91 buying power.
Most could not fill. Unclear whether the agent checks available cash
before queuing, or re-queues rejected orders blindly each session. Any
new system should check `buyingPower` before drafting anything.

**Concentration:** at audit time, DOT ($54, just opened) and AVAX ($87)
together were ~38% of total account value ($367) in two mid-cap alts.

## Registry discrepancy found and should be fixed

`docs/registry/PROJECT-REGISTRY.md` §8 and `docs/registry/CAPABILITY-MATRIX.md`
both stated (as of last verification, 2026-09-07) that live trading was
"not yet authorized, pending specific parameter confirmation" — but the
account had already been placing real trades continuously since 2026-09-04.
User has now confirmed authorization in this session (2026-09-09). Update
both files to reflect that, with today's date as the verification point,
so a future session doesn't act on the stale "not authorized" flag or,
conversely, treat live trading as unauthorized when it isn't.

## Signal research already completed — do not redo

See `crypto-signal-eval/SKILL.md` in this bundle for the full methodology,
but the headline result: a volume-expansion breakout signal (the price
signature of a short squeeze) was backtested on 365 days of DOT across 27
parameter configurations. All 27 lost money after costs. Against a
2000-draw random-entry baseline with identical exit rules, the signal
ranked worse than 78% of random draws — indistinguishable from noise,
slightly worse than average.

Reason this was expected to fail: a squeeze is caused by crowded short
positioning (funding rate, open interest) being forced to cover. Public's
MCP connector returns OHLCV only — no funding rate, no open interest, no
liquidation data. Price/volume only show the effect, after the fact. Any
signal built from Public data alone is missing the causal variable.

**Currently zero validated signals exist.** Until one clears the
backtest + random-baseline bar in the skill, this agent's job is
monitoring and reporting, not proposing trades.

## Standing safety principles already in this repo (do not weaken)

From `docs/BIG-BOSS-HANDOFF.md`:
- Read-only by default; approval required before any trade, purchase,
  deletion, or credential change.
- For financial/trading automation specifically: restrict to research,
  simulation, monitoring, and draft recommendations unless the user
  separately authorizes a specific live action.

From `README.md` safety principles:
- Reading and drafting are separate from consequential execution.
- Approval is matched against the exact proposed input.
- Approval-gated turns contain one action so nothing is silently dropped.

The new Public trading tool should follow all of these. Use
`preflight_order` (validates without executing) — never `place_order` —
for anything this agent proposes.

## Relationship to the existing Public.com Agent

Build this as a fully separate, standalone system — not a supervisor,
wrapper, or modifier of the existing Public.com Agent (the browser-only
one from PROJECT-REGISTRY.md §8). Reasons, for context if it comes up:

- The existing agent's decision logic is not visible via API — only its
  outcomes are, via trade history. A system bolted onto it can observe
  after the fact but can't intervene before a bad trade, which defeats
  the point of a draft-then-approve design.
- Two systems acting on the same capital makes buying power, sizing, and
  concentration harder to reason about. Keep them capital-independent
  where possible, or at minimum keep their logic and state fully
  separate even though they share one Public account.
- Running both in parallel, tracked separately, gives a real comparison:
  the existing agent's live (opaque) trades vs. this system's validated,
  reviewed drafts, over the same weeks. That comparison — not a priori
  reasoning — should inform whether the old agent eventually gets wound
  down. Don't make that call now; just make the comparison possible by
  keeping the two systems' logs distinct.

Do not pause, modify, or attempt to control the existing Public.com Agent
from this build. It stays exactly as-is unless the user says otherwise.
