---
status: accepted
---

# Polymarket US limit orders: a preview Tool and a permanently gated place Tool

Placing a Polymarket US order spends real money and cannot be undone once it fills, so it follows ADR 0004's split exactly: `polymarket-preview-order` asks Polymarket's own `/v1/order/preview` endpoint to validate and price an order without placing it, and `polymarket-place-order` is the separate, consequential Tool that calls `/v1/orders`. The place Tool is `requiresApproval: true` unconditionally. Unlike `browser-submit-form` (ADR 0018), no environment variable turns the gate off; an autopilot for trading would need its own ADR.

Only limit orders are supported. A limit order's worst case (price × quantity) is fixed when a human approves it, so exact-match approval means something. A market order's cost depends on the book when it fills. Both Tools share one validator (`parseLimitOrderRequest`): price must be a decimal strictly between 0 and 1, quantity a positive whole number, and time-in-force one of good-till-cancel, immediate-or-cancel or fill-or-kill. Good-till-date is left out until something needs its expiry field. Cancel, modify, close-position and fund movements are not built.

The real client (`src/integrations/polymarket/real-client.ts`) calls the API with `fetch` and signs each request with Node's built-in Ed25519. It does not use the `polymarket-us` SDK, which keeps ADR 0002's zero-dependency rule, as ADR 0006 did for Inkbox. The endpoints and the signing scheme (`X-PM-Access-Key`, `X-PM-Timestamp`, `X-PM-Signature` = Ed25519 over `timestamp + METHOD + path`) were read from Polymarket's published SDK, `polymarket-us` 0.1.1. Credentials come only from `POLYMARKET_KEY_ID` and `POLYMARKET_SECRET_KEY`. When they are missing, the Tools fail with a clear "not configured" error. There is deliberately no fake fallback outside tests, because a fake that "placed" an order would report a trade that never happened.

Both Tools are registered but attached to no Agent. Which Agent may trade, on whose instructions, and with what limits is a product decision still to be made. Nothing here has run against a live Polymarket account: every test uses a fake client or a stubbed `fetch` with a throwaway key.
