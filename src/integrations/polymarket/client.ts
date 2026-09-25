/**
 * The Polymarket US port (ADRs 0019, 0020). Deliberately narrow: search
 * markets and read a price (public, read-only), preview an order (safe),
 * and place one (consequential). Nothing here can cancel, modify, close a
 * position, or move funds — those are separate decisions, not built until
 * a real need justifies them.
 *
 * Only limit orders are supported. A limit order's worst-case cost
 * (price × quantity) is fixed at the moment a human approves it; a market
 * order's is not, which would make exact-match approval meaningless.
 */

export const ORDER_INTENTS = [
  "ORDER_INTENT_BUY_LONG",
  "ORDER_INTENT_SELL_LONG",
  "ORDER_INTENT_BUY_SHORT",
  "ORDER_INTENT_SELL_SHORT",
] as const;
export type OrderIntent = (typeof ORDER_INTENTS)[number];

/** GOOD_TILL_DATE is left out: it needs a goodTillTime this port doesn't carry yet. */
export const TIMES_IN_FORCE = [
  "TIME_IN_FORCE_GOOD_TILL_CANCEL",
  "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
  "TIME_IN_FORCE_FILL_OR_KILL",
] as const;
export type TimeInForce = (typeof TIMES_IN_FORCE)[number];

export interface LimitOrderRequest {
  readonly marketSlug: string;
  readonly intent: OrderIntent;
  readonly type: "ORDER_TYPE_LIMIT";
  /** Price per share in USD as a decimal string, strictly between 0 and 1 (e.g. "0.55"). */
  readonly price: { readonly value: string; readonly currency: "USD" };
  /** Whole number of shares. */
  readonly quantity: number;
  readonly tif: TimeInForce;
}

/** The order as Polymarket reports it back — passed through as-is from the preview endpoint. */
export interface PreviewedOrder {
  readonly marketSlug: string;
  readonly intent: string;
  readonly price: { readonly value: string; readonly currency: string };
  readonly quantity: number;
  readonly state: string;
  readonly marketTitle?: string;
  readonly marketOutcome?: string;
}

export interface PlacedOrder {
  readonly id: string;
  readonly executionCount: number;
}

/** One tradable Yes/No market found by a search. */
export interface MarketSummary {
  readonly eventTitle: string;
  readonly marketSlug: string;
  /** The market's question, e.g. "Will Kansas City Chiefs win the second half?". */
  readonly marketTitle: string;
  /** The side the question is about, e.g. "Kansas City Chiefs". */
  readonly outcome: string;
  readonly active: boolean;
  readonly closed: boolean;
}

/** Live prices for one market, as USD-per-share decimal strings; a field is absent when Polymarket didn't report it. */
export interface MarketQuote {
  readonly marketSlug: string;
  readonly state?: string;
  readonly bestBid?: string;
  readonly bestAsk?: string;
  /** What one "Yes" (long) share costs to buy right now. */
  readonly longQuote?: string;
  /** What one "No" (short) share costs to buy right now. */
  readonly shortQuote?: string;
  readonly lastTrade?: string;
}

export interface PolymarketClient {
  searchMarkets(query: string): Promise<readonly MarketSummary[]>;
  getQuote(marketSlug: string): Promise<MarketQuote>;
  previewOrder(request: LimitOrderRequest): Promise<PreviewedOrder>;
  placeOrder(request: LimitOrderRequest): Promise<PlacedOrder>;
}

/**
 * Validates an untrusted value (e.g. a Model's tool input) into a
 * LimitOrderRequest, or explains exactly what's wrong. Shared by both the
 * preview and place tools so they can never disagree about what counts as
 * a valid order.
 */
export function parseLimitOrderRequest(value: unknown): { ok: true; request: LimitOrderRequest } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return { ok: false, error: "input must be an object" };
  const v = value as Record<string, unknown>;

  if (typeof v["marketSlug"] !== "string" || v["marketSlug"].trim() === "") {
    return { ok: false, error: '"marketSlug" must be a non-empty string' };
  }
  if (!ORDER_INTENTS.includes(v["intent"] as OrderIntent)) {
    return { ok: false, error: `"intent" must be one of ${ORDER_INTENTS.join(", ")}` };
  }
  if (v["type"] !== "ORDER_TYPE_LIMIT") {
    return { ok: false, error: '"type" must be "ORDER_TYPE_LIMIT" — only limit orders are supported' };
  }
  const price = v["price"] as Record<string, unknown> | undefined;
  if (typeof price !== "object" || price === null || typeof price["value"] !== "string" || price["currency"] !== "USD") {
    return { ok: false, error: '"price" must be { "value": string, "currency": "USD" }' };
  }
  const priceValue = price["value"];
  const priceNumber = Number(priceValue);
  if (!/^\d*\.?\d+$/.test(priceValue) || !(priceNumber > 0 && priceNumber < 1)) {
    return { ok: false, error: '"price.value" must be a decimal strictly between 0 and 1 (e.g. "0.55")' };
  }
  const quantity = v["quantity"];
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
    return { ok: false, error: '"quantity" must be a positive whole number of shares' };
  }
  if (!TIMES_IN_FORCE.includes(v["tif"] as TimeInForce)) {
    return { ok: false, error: `"tif" must be one of ${TIMES_IN_FORCE.join(", ")}` };
  }

  return {
    ok: true,
    request: {
      marketSlug: v["marketSlug"],
      intent: v["intent"] as OrderIntent,
      type: "ORDER_TYPE_LIMIT",
      price: { value: priceValue, currency: "USD" },
      quantity,
      tif: v["tif"] as TimeInForce,
    },
  };
}

/**
 * The dollars at stake in an order, formatted as dollars. For LONG intents
 * this is exactly price × quantity. For SHORT intents it isn't verified
 * whether Polymarket reads the price as the Yes price or the No price, so
 * this takes the worse of the two (max(price, 1 − price) × quantity) and
 * the spending cap can never under-count a short order.
 */
export function orderNotional(request: LimitOrderRequest): string {
  const price = Number(request.price.value);
  const perShare = request.intent.endsWith("_SHORT") ? Math.max(price, 1 - price) : price;
  return (perShare * request.quantity).toFixed(2);
}

export const DEFAULT_MAX_ORDER_USD = 10;

/**
 * The per-order spending cap: POLYMARKET_MAX_ORDER_USD if it's a positive
 * number, otherwise $10. Read on every call rather than at startup, so
 * lowering it takes effect without rebuilding anything.
 */
export function maxOrderUsd(): number {
  const configured = Number(process.env["POLYMARKET_MAX_ORDER_USD"]);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_ORDER_USD;
}

/** Throws when an order's notional exceeds the cap — checked before preview and again before placing. */
export function assertWithinCap(request: LimitOrderRequest, toolName: string): void {
  const notional = Number(orderNotional(request));
  const cap = maxOrderUsd();
  if (notional > cap) {
    throw new Error(
      `${toolName}: this order is $${notional.toFixed(2)}, over the $${cap.toFixed(2)} per-order cap (POLYMARKET_MAX_ORDER_USD). ` +
        "Use a smaller quantity, or have the owner raise the cap.",
    );
  }
}
