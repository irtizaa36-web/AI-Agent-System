import { parseDecimal, parseOptionalDecimal } from "./decimal";
import type {
  DraftOrder,
  EquityBucket,
  OpenOrder,
  OrderSide,
  PortfolioSnapshot,
  Position,
  PreflightResult,
  PriceBar,
  Quote,
  Transaction,
} from "./types";

/**
 * The port this system talks to the Public.com connector through.
 *
 * **The safety boundary is the shape of this interface.** It exposes the four
 * read tools the brief allows (`get_portfolio`, `get_history`, `get_quotes`,
 * `get_price_history`) plus `preflight_order`, which validates an order's cost
 * and buying-power impact without placing it. There is no `placeOrder` method,
 * no generic `call(toolName, ...)` escape hatch, and no way to reach the
 * connector except through this interface — so "never `place_order`" is
 * enforced by the type system at compile time, not by a runtime guard that a
 * future edit could quietly drop. Adding execution here would be a visible,
 * reviewable change to the module's contract, which is exactly the property
 * the repo's "reading and drafting are separate from consequential execution"
 * principle (README safety principle 1, ADR 0004) is asking for.
 *
 * This is also why the module is standalone rather than bolted onto the
 * existing Public.com Agent: that agent's decision logic is not reachable
 * over any API, only its outcomes are (BRIEFING.md, "Relationship to the
 * existing Public.com Agent"). Nothing here reads, pauses, or controls it.
 */
export interface PublicTradingClient {
  getPortfolio(accountId: string): Promise<PortfolioSnapshot>;
  /** Returns every transaction in the window, following pagination to exhaustion. */
  getHistory(accountId: string, options?: HistoryQuery): Promise<readonly Transaction[]>;
  getQuotes(accountId: string, symbols: readonly string[], instrumentType?: string): Promise<readonly Quote[]>;
  /**
   * Bars for signal work only. The review pipeline never calls this: per
   * `.agents/skills/crypto-signal-eval/SKILL.md` ("Token efficiency"), price
   * history must go to disk for `backtest.py` to read, never into an agent's
   * context. `writePriceHistoryCsv` in `price-history.ts` is the intended sink.
   */
  getPriceHistory(accountId: string, symbol: string, options?: PriceHistoryQuery): Promise<readonly PriceBar[]>;
  /** Validates an order's cost and buying-power impact. Places nothing. */
  preflightOrder(accountId: string, order: DraftOrder): Promise<PreflightResult>;
}

export interface HistoryQuery {
  readonly start?: string;
  readonly end?: string;
  readonly pageSize?: number;
}

export interface PriceHistoryQuery {
  readonly period?: string;
  readonly interval?: string;
  readonly instrumentType?: string;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Expected an object for ${context}, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * The API reports percentages as whole numbers ("23.94" meaning 23.94%). Every
 * percentage inside this module is a ratio instead, so a caller can never
 * accidentally multiply by 100 twice.
 */
function percentToRatio(value: unknown, fallback = 0): number {
  return parseOptionalDecimal(value, fallback * 100) / 100;
}

export function normalisePosition(raw: unknown): Position {
  const record = asRecord(raw, "position");
  const instrument = asRecord(record["instrument"], "position.instrument");
  const costBasis = asRecord(record["costBasis"] ?? {}, "position.costBasis");
  const lastPrice = asRecord(record["lastPrice"] ?? {}, "position.lastPrice");
  const totalCost = parseOptionalDecimal(costBasis["totalCost"], 0);
  const gainValue = parseOptionalDecimal(costBasis["gainValue"], 0);
  return {
    symbol: asString(instrument["symbol"]),
    name: asString(instrument["name"]),
    instrumentType: asString(instrument["type"]),
    quantity: parseOptionalDecimal(record["quantity"], 0),
    openedAt: asString(record["openedAt"]),
    currentValue: parseDecimal(record["currentValue"], "position.currentValue"),
    percentOfPortfolio: percentToRatio(record["percentOfPortfolio"]),
    lastPrice: parseOptionalDecimal(lastPrice["lastPrice"], 0),
    totalCost,
    unitCost: parseOptionalDecimal(costBasis["unitCost"], 0),
    unrealisedGain: gainValue,
    // Derived from dollars rather than trusting the API's own gainPercentage:
    // its sibling `instrumentGain.gainPercentage` describes the instrument's
    // move, not the position's, and the two are easy to confuse.
    unrealisedGainRatio: totalCost === 0 ? 0 : gainValue / totalCost,
  };
}

export function normaliseOpenOrder(raw: unknown): OpenOrder {
  const record = asRecord(raw, "order");
  const instrument = asRecord(record["instrument"] ?? {}, "order.instrument");
  const limitPrice = record["limitPrice"];
  return {
    orderId: asString(record["orderId"]),
    symbol: asString(instrument["symbol"]),
    instrumentType: asString(instrument["type"]),
    side: asString(record["side"], "BUY") as OrderSide,
    orderType: asString(record["type"]),
    status: asString(record["status"]),
    createdAt: asString(record["createdAt"]),
    notionalValue: parseOptionalDecimal(record["notionalValue"], 0),
    ...(limitPrice === undefined || limitPrice === null ? {} : { limitPrice: parseOptionalDecimal(limitPrice, 0) }),
    filledQuantity: parseOptionalDecimal(record["filledQuantity"], 0),
  };
}

export function normaliseEquityBucket(raw: unknown): EquityBucket {
  const record = asRecord(raw, "equity bucket");
  return {
    type: asString(record["type"]),
    value: parseOptionalDecimal(record["value"], 0),
    percentOfPortfolio: percentToRatio(record["percentageOfPortfolio"]),
  };
}

/** Maps a raw `get_portfolio` response onto `PortfolioSnapshot`. */
export function normalisePortfolio(raw: unknown): PortfolioSnapshot {
  const record = asRecord(raw, "portfolio");
  const buyingPower = asRecord(record["buyingPower"] ?? {}, "portfolio.buyingPower");
  return {
    accountId: asString(record["accountId"]),
    accountType: asString(record["accountType"]),
    buyingPower: parseDecimal(buyingPower["buyingPower"], "buyingPower.buyingPower"),
    cash: parseOptionalDecimal(record["cash"], 0),
    totalAccountValue: parseDecimal(record["totalAccountValue"], "totalAccountValue"),
    equity: asArray(record["equity"]).map(normaliseEquityBucket),
    positions: asArray(record["positions"]).map(normalisePosition),
    openOrders: asArray(record["orders"]).map(normaliseOpenOrder),
  };
}

/** Maps one raw history transaction onto `Transaction`. */
export function normaliseTransaction(raw: unknown): Transaction {
  const record = asRecord(raw, "transaction");
  const symbol = record["symbol"];
  const securityType = record["securityType"];
  const side = record["side"];
  return {
    id: asString(record["id"]),
    timestamp: asString(record["timestamp"]),
    type: asString(record["type"]),
    subType: asString(record["subType"]),
    ...(typeof symbol === "string" ? { symbol } : {}),
    ...(typeof securityType === "string" ? { securityType } : {}),
    ...(side === "BUY" || side === "SELL" ? { side: side as OrderSide } : {}),
    description: asString(record["description"]),
    netAmount: parseOptionalDecimal(record["netAmount"], 0),
    principalAmount: parseOptionalDecimal(record["principalAmount"], 0),
    quantity: parseOptionalDecimal(record["quantity"], 0),
    fees: parseOptionalDecimal(record["fees"], 0),
  };
}

/** Maps a raw `get_history` page onto its transactions plus the cursor for the next page. */
export function normaliseHistoryPage(raw: unknown): {
  readonly transactions: readonly Transaction[];
  readonly nextToken?: string;
} {
  const record = asRecord(raw, "history page");
  const nextToken = record["nextToken"];
  return {
    transactions: asArray(record["transactions"]).map(normaliseTransaction),
    ...(typeof nextToken === "string" && nextToken !== "" ? { nextToken } : {}),
  };
}

export function normaliseQuote(raw: unknown): Quote {
  const record = asRecord(raw, "quote");
  const bid = record["bid"];
  const ask = record["ask"];
  return {
    symbol: asString(record["symbol"]),
    last: parseOptionalDecimal(record["last"] ?? record["lastPrice"] ?? record["price"], 0),
    ...(bid === undefined || bid === null ? {} : { bid: parseOptionalDecimal(bid, 0) }),
    ...(ask === undefined || ask === null ? {} : { ask: parseOptionalDecimal(ask, 0) }),
  };
}

/** Maps a raw `preflight_order` response onto `PreflightResult`. */
export function normalisePreflight(raw: unknown): PreflightResult {
  const record = asRecord(raw, "preflight result");
  const message = record["message"] ?? record["error"] ?? record["reason"];
  const rejected =
    record["accepted"] === false ||
    record["success"] === false ||
    typeof record["error"] === "string" ||
    asString(record["status"]).toUpperCase() === "REJECTED";
  return {
    accepted: !rejected,
    estimatedCommission: parseOptionalDecimal(record["estimatedCommission"] ?? record["commission"], 0),
    estimatedRegulatoryFees: parseOptionalDecimal(
      record["estimatedRegulatoryFees"] ?? record["regulatoryFees"] ?? record["fees"],
      0,
    ),
    orderValue: parseOptionalDecimal(record["orderValue"] ?? record["notionalValue"], 0),
    buyingPowerRequired: parseOptionalDecimal(
      record["buyingPowerRequired"] ?? record["buyingPowerImpact"] ?? record["orderValue"],
      0,
    ),
    ...(typeof message === "string" ? { message } : {}),
    raw,
  };
}
