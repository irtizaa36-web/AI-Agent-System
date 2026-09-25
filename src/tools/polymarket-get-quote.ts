import type { Tool } from "./tool";
import type { PolymarketClient } from "../integrations/polymarket/client";

/** Read-only: the current best bid/ask for one market, so a limit price is grounded in the live book. */
export function createPolymarketGetQuoteTool(client: PolymarketClient): Tool {
  return {
    name: "polymarket-get-quote",
    description:
      "Returns live prices (USD per share) for one Polymarket US market slug: cost to buy Yes (longQuote), cost to buy No (shortQuote), best bid/ask, last trade, and market state. Read-only.",
    inputSchema: {
      type: "object",
      properties: { marketSlug: { type: "string" } },
      required: ["marketSlug"],
    },
    async execute(input: unknown): Promise<string> {
      const marketSlug = (input as { marketSlug?: unknown } | null)?.marketSlug;
      if (typeof marketSlug !== "string" || marketSlug.trim() === "") {
        throw new Error('polymarket-get-quote requires { "marketSlug": string }');
      }
      const quote = await client.getQuote(marketSlug);
      return [
        `marketSlug:${quote.marketSlug}`,
        `state:${quote.state ?? "(unknown)"}`,
        `buyYesPrice(longQuote):${quote.longQuote ?? "(none)"}`,
        `buyNoPrice(shortQuote):${quote.shortQuote ?? "(none)"}`,
        `bestBid:${quote.bestBid ?? "(none)"}`,
        `bestAsk:${quote.bestAsk ?? "(none)"}`,
        `lastTrade:${quote.lastTrade ?? "(none)"}`,
      ].join("\n");
    },
  };
}
