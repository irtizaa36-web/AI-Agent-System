#!/bin/bash
# Scheduled market check-in — one of four per trading day.
#
# Takes the slot as its only argument: pre-open | opening | midday | pre-close.
# Register four entries (launchd/cron), one per slot, at these ET times:
#
#   pre-open    09:00 ET   30 minutes before the bell
#   opening     09:35 ET   5 minutes after the bell
#   midday      12:00 ET   noon
#   pre-close   15:30 ET   30 minutes before the close
#
# CRON IS UTC; THESE TIMES ARE ET. During EDT (Mar–Nov) ET is UTC-4, during EST
# it is UTC-5, so a fixed UTC cron drifts by an hour twice a year. Two ways to
# get this right, pick one:
#
#   a) launchd on macOS with StartCalendarInterval, which follows the machine's
#      local timezone automatically. Preferred — set the Mac to ET.
#   b) cron with CRON_TZ=America/New_York at the top of the crontab:
#         CRON_TZ=America/New_York
#         0  9 * * 1-5  .../market-review-checkin.sh pre-open
#         35 9 * * 1-5  .../market-review-checkin.sh opening
#         0 12 * * 1-5  .../market-review-checkin.sh midday
#         30 15 * * 1-5 .../market-review-checkin.sh pre-close
#
# A plain UTC crontab will be an hour wrong for part of the year. The check-in
# itself flags that case (SLOT_TIME_DRIFT) rather than silently reporting numbers
# from the wrong moment, but the fix belongs in the schedule.
#
# `1-5` covers weekdays only. Market holidays are NOT excluded — the run will
# fire, notice there is no live market, and write an explicit "did not complete"
# entry rather than a report that looks real.
#
# SAFETY: this system reads and drafts only. Its client interface
# (src/tools/market-review/client.ts) exposes get_quotes, get_option_expirations,
# get_option_chain, get_option_greeks and get_portfolio — and nothing else. There
# is no place_order path, and not even a preflight: this system never proposes an
# order as an executable action. It also does not read, pause, modify or control
# the existing Public.com Agents (PROJECT-REGISTRY.md §8), which keep running.
#
# Suggested sizes in these reports are arithmetic against a stated risk budget
# and are deliberately NOT checked against live buying power — that was an
# explicit operator decision. Every report repeats the disclaimer.

set -euo pipefail

# Validated before the `cd` so a bad argument fails immediately and identically
# on any machine, rather than depending on whether the repo path resolves first.
SLOT="${1:-}"
case "$SLOT" in
  pre-open|opening|midday|pre-close) ;;
  *)
    echo "Usage: $0 <pre-open|opening|midday|pre-close>" >&2
    exit 1
    ;;
esac

cd "/Users/irtizaahmed/AI-Agent-System"

# Per-idea risk budget, in dollars. The check-in refuses to run without one
# rather than inventing a figure; change it here deliberately.
RISK_BUDGET="${MARKET_REVIEW_RISK_BUDGET:-250}"

PROMPT="In the AI-Agent-System repo, run the '$SLOT' market check-in.

Read docs/operations/market-review.md first if you have not already — it defines
this system's boundaries, the input shape, and what each slot is for.

1. git pull
2. npm ci && npm run build
3. node dist/cli/index.js agent-status set PublicTrading --status working --task '$SLOT market check-in'
4. Using the Public MCP connector, call ONLY these read tools:
   - public:get_portfolio for account 5OI24720
   - public:get_quotes for VIX with instrument_type INDEX (every run — VIX is the
     primary volatility gauge)
   - public:get_quotes for the underlyings you are pricing this run
   - public:get_option_expirations / public:get_option_chain for the underlyings
     in config/market-review-watchlist.json's optionUnderlyings list
   Do NOT call place_order, any place_* tool, cancel_order, preflight_order, or
   flatten_and_go_short. This run has no authority to place, cancel or modify any
   order, and no reason to preflight one.

   TIMING: for every slot except pre-open, do not use a quote timestamped before
   09:30 ET — a premarket quote carries the prior close and silently corrupts
   every derived figure. The tool flags this, but do not rely on the flag.

5. Cross-check today's market-moving events: use the Zacks news tool and a web
   search for CPI / FOMC / jobs / Fed speakers / earnings on your candidates.
   Re-check macro odds live every run — never carry forward yesterday's estimate.

6. Build the check-in input JSON. Pass RAW connector responses, not computed
   numbers: the CLI does the breakeven, theta, required-move, IV and sizing maths
   itself so it stays under test. The shape is documented in
   docs/operations/market-review.md. It must include
   \"sizing\": {\"riskBudgetUsd\": $RISK_BUDGET}.

   For each thesis you state, the 'mechanism' field is mandatory and must be a
   causal reason, not an observation. 'It is moving' is not a mechanism, and the
   CLI rejects an empty one.

7. node dist/cli/index.js market-review check-in --slot $SLOT --input <that file>

   If the connector failed, the market is closed, or the data is unusable, pass
   \"incomplete\": {\"reason\": \"...\", \"details\": [...]} instead of guessing.
   A run that says it could not complete is correct; a run that fabricates a
   plausible report is not.

8. node dist/cli/index.js agent-status set PublicTrading --status idle
9. git add docs/operations/market-review coworker/agents/PublicTrading.json &&
   git commit -m 'market-review: $SLOT check-in' && git push
   (if push is rejected because the remote moved, git pull --rebase once and push again)
10. Send a push notification with a one-line summary: the slot, the number of
    recommendations, and the single most important flag. On a failed run, say so
    in that line — do not go quiet.

Do this without asking for confirmation on each step. Never place, cancel or
modify an order, and never touch the existing Public.com Agents' configuration.
If a trade looks warranted, the answer is the written report plus an explicit
ask — never an order."

echo "$PROMPT" | /Users/irtizaahmed/.local/bin/claude -p
