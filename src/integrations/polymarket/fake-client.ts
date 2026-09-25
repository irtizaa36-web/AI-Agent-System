import type { LimitOrderRequest, MarketQuote, MarketSummary, PlacedOrder, PolymarketClient, PreviewedOrder } from "./client";

/** An in-memory PolymarketClient for tests: records every call, never touches the network. */
export class FakePolymarketClient implements PolymarketClient {
  public readonly previewCalls: LimitOrderRequest[] = [];
  public readonly placedCalls: LimitOrderRequest[] = [];

  constructor(
    private readonly markets: readonly MarketSummary[] = [],
    private readonly quotes: ReadonlyMap<string, MarketQuote> = new Map(),
  ) {}

  async searchMarkets(query: string): Promise<readonly MarketSummary[]> {
    const needle = query.toLowerCase();
    return this.markets.filter((m) => `${m.eventTitle} ${m.marketTitle} ${m.marketSlug}`.toLowerCase().includes(needle));
  }

  async getQuote(marketSlug: string): Promise<MarketQuote> {
    return this.quotes.get(marketSlug) ?? { marketSlug };
  }

  async previewOrder(request: LimitOrderRequest): Promise<PreviewedOrder> {
    this.previewCalls.push(request);
    return {
      marketSlug: request.marketSlug,
      intent: request.intent,
      price: request.price,
      quantity: request.quantity,
      state: "ORDER_STATE_NEW",
    };
  }

  async placeOrder(request: LimitOrderRequest): Promise<PlacedOrder> {
    this.placedCalls.push(request);
    return { id: `fake-order-${this.placedCalls.length}`, executionCount: 0 };
  }
}
