import type { Tool } from "./tool";
import { assertWithinCap, maxOrderUsd, orderNotional, parseLimitOrderRequest, type PolymarketClient } from "../integrations/polymarket/client";
import { POLYMARKET_ORDER_INPUT_SCHEMA } from "./polymarket-place-order";

/**
 * Safe half of the Polymarket pair (ADR 0004/0019): asks Polymarket to
 * validate and price an order without placing it. Its output is what a
 * human reviews before approving the exact same input to
 * polymarket-place-order.
 */
export function createPolymarketPreviewOrderTool(client: PolymarketClient): Tool {
  return {
    name: "polymarket-preview-order",
    description:
      "Previews a Polymarket US limit order without placing it: Polymarket validates it and reports the order it would create. Safe — never trades.",
    inputSchema: POLYMARKET_ORDER_INPUT_SCHEMA,
    async execute(input: unknown): Promise<string> {
      const parsed = parseLimitOrderRequest(input);
      if (!parsed.ok) throw new Error(`polymarket-preview-order: ${parsed.error}`);
      assertWithinCap(parsed.request, "polymarket-preview-order");
      const preview = await client.previewOrder(parsed.request);
      return [
        "previewed:true",
        "placed:false",
        `marketSlug:${preview.marketSlug}`,
        ...(preview.marketTitle ? [`marketTitle:${preview.marketTitle}`] : []),
        ...(preview.marketOutcome ? [`marketOutcome:${preview.marketOutcome}`] : []),
        `intent:${preview.intent}`,
        `price:${preview.price.value} ${preview.price.currency}`,
        `quantity:${preview.quantity}`,
        `notionalUSD:${orderNotional(parsed.request)}`,
        `perOrderCapUSD:${maxOrderUsd().toFixed(2)}`,
        `tif:${parsed.request.tif}`,
        `state:${preview.state}`,
      ].join("\n");
    },
  };
}
