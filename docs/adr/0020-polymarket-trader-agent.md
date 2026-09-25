---
status: accepted
---

# Polymarket Trader agent, market lookups, and a per-order spending cap

ADR 0019 built the gated order Tools and left open which Agent may use them. The owner chose to have an AI agent draft trades. A new `prediction-markets` Pack registers one agent, `polymarket-trader`. It turns a plain-English request into one limit order and then stops at the existing exact-match approval gate. It is dispatchable, so the owner uses it through the approval flow that already exists: `orchestrator dispatch run --task "..."` pauses at the order, `orchestrator dispatch approve <id>` shows the exact order, and `--yes` places it.

Two read-only Tools keep the agent from guessing. `polymarket-find-markets` searches open markets on Polymarket's public gateway, capped at 30 results because one sports event can carry hundreds of prop markets. `polymarket-get-quote` reads the live Yes and No prices. Neither needs credentials, so the client now always exists and only order preview and placement require `POLYMARKET_KEY_ID` / `POLYMARKET_SECRET_KEY`. The live gateway's responses differ from the published SDK's type declarations: markets carry `question`/`title` rather than `outcome`, and the price body is wrapped in `marketData`. The client follows the live shapes, observed on 2026-09-25.

A per-order spending cap, `POLYMARKET_MAX_ORDER_USD`, defaults to $10. An unset, unparseable or non-positive value falls back to $10, never to unlimited. It is enforced in code by both the preview and place Tools, and re-checked when the place Tool executes, so lowering it also blocks an order already awaiting approval. For SHORT intents it is not verified whether Polymarket reads the order price as the Yes price or the No price. The cap therefore counts the worse of the two, and the agent's instructions prefer LONG orders and require it to tell the owner about this uncertainty.

The prompt handles judgment only: never invent a market slug, base the price on the live quote, spell out the dollars at risk, propose at most one order per task, never split an order to dodge the cap, and never present an opinion as an information edge. The hard limits (approval, cap, limit-only) live in code.

Nothing has placed a live order yet. Market search and quotes were exercised against the live public gateway; preview and placement are covered only by fakes and a stubbed `fetch`.
