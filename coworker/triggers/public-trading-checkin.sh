#!/bin/bash
# Daily check-in for the "PublicTrading" coworker persona.
#
# Runs the standalone Public.com monitoring review once a day and commits the
# result. Registered via launchd/cron — see coworker/README.md for the protocol
# and docs/operations/public-trading.md for what this system is and is not.
#
# Cadence is daily, not intraday, on purpose: the signal research and the
# backtest bar are both on daily bars, every number the review reports (realised
# P/L, cost drag, concentration) is cumulative, and one `get_history` pull
# captures every trade regardless of when it runs. With no validated signal
# registered there is nothing to time an entry against, so a 4-hourly cadence
# would produce six times the files carrying the same information. Revisit this
# when a signal clears the evidence bar and entry timing starts to matter.
#
# SAFETY: this system reads and drafts only. It calls get_portfolio, get_history,
# get_quotes, get_price_history and preflight_order. It never calls place_order —
# the client interface in src/tools/public-trading/client.ts exposes no method
# that could. It also does not read, pause, modify or control the existing
# Public.com Agent (PROJECT-REGISTRY.md §8), which keeps running as-is.

set -euo pipefail
cd "/Users/irtizaahmed/AI-Agent-System"

PROMPT='In the AI-Agent-System repo, run the daily check-in for the "PublicTrading" coworker persona.

Read docs/operations/public-trading.md first if you have not already — it defines
this systems boundaries.

1. git pull
2. npm ci && npm run build
3. node dist/cli/index.js agent-status set PublicTrading --status working --task "daily monitoring review"
4. Using the Public MCP connector, call ONLY these read tools:
   - public:get_accounts (to confirm the sole BROKERAGE account id)
   - public:get_portfolio for that account
   - public:get_history for that account, from 30 days ago to now. Follow
     nextToken until it is absent — a page can return fewer transactions than
     the page size and still have more behind it.
   Do NOT call place_order, place_short_order, any place_* tool, cancel_order,
   or flatten_and_go_short. This run has no authority to place, cancel or modify
   any order. If something looks like it needs a trade, write it up in the review
   and stop — the human decides.
5. Write the raw responses to a scratch file as JSON:
   {"accountId": "<id>", "portfolio": <get_portfolio result>, "history": <get_history result>}
   If you followed pagination, merge the pages transactions into one array.
6. node dist/cli/index.js public-trading review --input <that file>
   This writes docs/operations/public-trading/YYYY-MM-DD.md and prints a summary.
   It reads the previous reviews watermark automatically, so "closed since last
   run" is correct without any manual bookkeeping.
7. Read the printed summary. If it flags anything — a concentration threshold, an
   infeasible open-order queue, or realised cost drag materially above the 0.75%
   baseline in BRIEFING.md — add a short note to issue #1 saying what changed.
   Do not open an issue for a quiet run; the committed review file is the record.
8. node dist/cli/index.js agent-status set PublicTrading --status idle
9. git add docs/operations/public-trading coworker/agents/PublicTrading.json &&
   git commit -m "PublicTrading: daily monitoring review" && git push
   (if push is rejected because the remote moved, git pull --rebase once and push again)

Do this without asking for confirmation on each step. Never place, cancel or
modify an order, and never touch the existing Public.com Agents configuration.
If a trade ever looks warranted, the answer is a written draft in the review file
plus an explicit ask — never an order.'

echo "$PROMPT" | /Users/irtizaahmed/.local/bin/claude -p
