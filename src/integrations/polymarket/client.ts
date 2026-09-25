/**
 * The Polymarket US trading port (ADR 0019). Deliberately narrow: preview an
 * order (safe, read-only) and place one (consequential). Nothing here can
 * cancel, modify, close a position, or move funds — those are separate
 * decisions, not built until a real need justifies them.
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

export interface PolymarketClient {
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

/** Worst-case cash outlay for a buy, or worst-case proceeds for a sell, formatted as dollars. */
export function orderNotional(request: LimitOrderRequest): string {
  return (Number(request.price.value) * request.quantity).toFixed(2);
}
