import type { LimitOrderRequest, PlacedOrder, PolymarketClient, PreviewedOrder } from "./client";

/** An in-memory PolymarketClient for tests: records every call, never touches the network. */
export class FakePolymarketClient implements PolymarketClient {
  public readonly previewCalls: LimitOrderRequest[] = [];
  public readonly placedCalls: LimitOrderRequest[] = [];

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
