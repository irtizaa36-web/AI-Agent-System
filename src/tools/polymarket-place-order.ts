import type { Tool } from "./tool";
import { ORDER_INTENTS, TIMES_IN_FORCE, assertWithinCap, orderNotional, parseLimitOrderRequest, type PolymarketClient } from "../integrations/polymarket/client";

export const POLYMARKET_ORDER_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    marketSlug: { type: "string" },
    intent: { type: "string", enum: [...ORDER_INTENTS] },
    type: { type: "string", enum: ["ORDER_TYPE_LIMIT"] },
    price: {
      type: "object",
      properties: { value: { type: "string" }, currency: { type: "string", enum: ["USD"] } },
      required: ["value", "currency"],
    },
    quantity: { type: "integer", minimum: 1 },
    tif: { type: "string", enum: [...TIMES_IN_FORCE] },
  },
  required: ["marketSlug", "intent", "type", "price", "quantity", "tif"],
};

/**
 * Consequential: places a real-money order on Polymarket US (ADR 0019).
 * `requiresApproval` is unconditionally true — unlike browser-submit-form
 * (ADR 0018) there is no env var that removes this gate. The Orchestrator
 * never auto-executes it; it only runs via approveAndExecute after a human
 * has matched every field of the order exactly. The per-order spending cap
 * (POLYMARKET_MAX_ORDER_USD, default $10) is re-checked here at execution
 * time, so an order approved under a higher cap still can't go through
 * after the cap is lowered.
 */
export function createPolymarketPlaceOrderTool(client: PolymarketClient): Tool {
  return {
    name: "polymarket-place-order",
    description:
      "Places a Polymarket US limit order with real money. Consequential: only ever runs after exact-match human approval. Call polymarket-preview-order with the same input first.",
    inputSchema: POLYMARKET_ORDER_INPUT_SCHEMA,
    requiresApproval: true,
    async execute(input: unknown): Promise<string> {
      const parsed = parseLimitOrderRequest(input);
      if (!parsed.ok) throw new Error(`polymarket-place-order: ${parsed.error}`);
      assertWithinCap(parsed.request, "polymarket-place-order");
      const result = await client.placeOrder(parsed.request);
      return [
        "placed:true",
        `orderId:${result.id}`,
        `marketSlug:${parsed.request.marketSlug}`,
        `intent:${parsed.request.intent}`,
        `price:${parsed.request.price.value} USD`,
        `quantity:${parsed.request.quantity}`,
        `notionalUSD:${orderNotional(parsed.request)}`,
        `tif:${parsed.request.tif}`,
        `executionsSoFar:${result.executionCount}`,
      ].join("\n");
    },
  };
}
