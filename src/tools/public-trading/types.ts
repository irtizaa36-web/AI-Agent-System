/**
 * Normalised domain types for the standalone Public.com monitoring system.
 *
 * These are deliberately *not* the raw Public API shapes. The raw responses
 * carry every number as a decimal string and nest values under wrappers
 * (`buyingPower.buyingPower`, `lastPrice.lastPrice`, `costBasis.totalCost`).
 * Normalising at the boundary (see `client.ts`) means the analysis and
 * rendering code below never re-parses a string or reaches through a wrapper,
 * and a change in the vendor's response shape is a one-file edit.
 */

export type InstrumentType = "EQUITY" | "CRYPTO" | "OPTION" | "INDEX" | "ALT" | "BOND" | "TREASURY";

export type OrderSide = "BUY" | "SELL";

/** One open (unfilled or partly filled) order sitting against the account. */
export interface OpenOrder {
  readonly orderId: string;
  readonly symbol: string;
  readonly instrumentType: string;
  readonly side: OrderSide;
  readonly orderType: string;
  readonly status: string;
  readonly createdAt: string;
  /** Dollar value the order would consume if it filled in full. */
  readonly notionalValue: number;
  readonly limitPrice?: number;
  readonly filledQuantity: number;
}

/** One held position, with cost basis resolved to plain numbers. */
export interface Position {
  readonly symbol: string;
  readonly name: string;
  readonly instrumentType: string;
  readonly quantity: number;
  readonly openedAt: string;
  readonly currentValue: number;
  /** Share of `totalAccountValue`, as a ratio (0.2394), not the API's "23.94". */
  readonly percentOfPortfolio: number;
  readonly lastPrice: number;
  readonly totalCost: number;
  readonly unitCost: number;
  /** Unrealised P/L against cost basis, in dollars. */
  readonly unrealisedGain: number;
  /** Unrealised P/L as a ratio of cost. */
  readonly unrealisedGainRatio: number;
}

/** Equity broken out by asset class, as the API reports it. */
export interface EquityBucket {
  readonly type: string;
  readonly value: number;
  readonly percentOfPortfolio: number;
}

/** A point-in-time account snapshot: what `get_portfolio` returns, normalised. */
export interface PortfolioSnapshot {
  readonly accountId: string;
  readonly accountType: string;
  /** Cash available to open a new position right now. The gate every draft checks first. */
  readonly buyingPower: number;
  readonly cash: number;
  readonly totalAccountValue: number;
  readonly equity: readonly EquityBucket[];
  readonly positions: readonly Position[];
  readonly openOrders: readonly OpenOrder[];
}

/** One transaction from `get_history`, normalised. Covers trades and money movements. */
export interface Transaction {
  readonly id: string;
  readonly timestamp: string;
  readonly type: string;
  readonly subType: string;
  readonly symbol?: string;
  readonly securityType?: string;
  readonly side?: OrderSide;
  readonly description: string;
  /** Cash actually moved, fees and spread included. Negative for a buy. */
  readonly netAmount: number;
  /** Gross value at the quoted execution price, before fees and spread. */
  readonly principalAmount: number;
  readonly quantity: number;
  readonly fees: number;
}

/** A real-time quote from `get_quotes`, normalised. */
export interface Quote {
  readonly symbol: string;
  readonly last: number;
  readonly bid?: number;
  readonly ask?: number;
}

/** One OHLCV bar from `get_price_history`. */
export interface PriceBar {
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** What `preflight_order` reports back: costs and buying-power impact, with nothing executed. */
export interface PreflightResult {
  readonly accepted: boolean;
  readonly estimatedCommission: number;
  readonly estimatedRegulatoryFees: number;
  readonly orderValue: number;
  readonly buyingPowerRequired: number;
  /** Vendor message, surfaced verbatim into the review so a rejection reason is never paraphrased. */
  readonly message?: string;
  readonly raw: unknown;
}

/**
 * A single-leg order this system may *describe*. There is deliberately no
 * path from this type to execution anywhere in the module — see
 * `PublicTradingClient` for why that is a structural guarantee rather than
 * a runtime check.
 */
export interface DraftOrder {
  readonly symbol: string;
  readonly instrumentType: InstrumentType;
  readonly side: OrderSide;
  readonly orderType: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  readonly amount?: number;
  readonly quantity?: number;
  readonly limitPrice?: number;
  readonly stopPrice?: number;
  readonly timeInForce?: "DAY" | "GTD";
}
