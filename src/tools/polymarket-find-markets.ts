import type { Tool } from "./tool";
import type { PolymarketClient } from "../integrations/polymarket/client";

/** Read-only: searches active Polymarket US markets so an agent uses a real market slug instead of guessing one. */
export function createPolymarketFindMarketsTool(client: PolymarketClient): Tool {
  return {
    name: "polymarket-find-markets",
    description:
      "Searches active Polymarket US markets by keyword (e.g. \"Chiefs Super Bowl\") and returns up to 30 open Yes/No markets with their slug and question. Read-only.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    async execute(input: unknown): Promise<string> {
      const query = (input as { query?: unknown } | null)?.query;
      if (typeof query !== "string" || query.trim() === "") {
        throw new Error('polymarket-find-markets requires { "query": string }');
      }
      const markets = await client.searchMarkets(query);
      if (markets.length === 0) return `No active markets found for "${query}".`;
      return markets
        .map((m) => `marketSlug:${m.marketSlug} | event:${m.eventTitle} | question:${m.marketTitle} | about:${m.outcome}`)
        .join("\n");
    },
  };
}
