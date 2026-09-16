/**
 * Normalised domain types for the market-review system: scheduled portfolio
 * check-ins that surface option and stock candidates for human review.
 *
 * Like `../public-trading/types.ts`, these are deliberately *not* the raw
 * Public API shapes. The raw responses carry every number as a decimal string
 * and nest values under wrappers (`lastPrice.lastPrice`, `oneDayChange.change`).
 * Normalising at the boundary (`client.ts`) means the analysis and rendering
 * code never re-parses a string or reaches through a wrapper.
 *
 * One unit convention runs through every type here, because getting it wrong
 * is the single most expensive mistake available in options work (see
 * `.agents/skills/options-trading-eval/SKILL.md`, "Gotchas that produce 100×
 * errors"): **every per-share figure stays per-share, and every per-contract
 * figure is named `…PerContract`.** A `theta` of -0.0093 is per share; the
 * same value per contract is -0.93. No field mixes the two.
 */

export type OptionSide = "CALL" | "PUT";

/** Which scheduled slot a run belongs to. Each renders a different report. */
export type CheckInSlot = "pre-open" | "opening" | "midday" | "pre-close";

/** The four slots in the order they fire during a trading day. */
export const CHECK_IN_SLOTS: readonly CheckInSlot[] = ["pre-open", "opening", "midday", "pre-close"];

/** Wall-clock ET time each slot targets, for rendering and for the staleness guard. */
export const SLOT_TARGET_ET: Readonly<Record<CheckInSlot, string>> = {
  "pre-open": "09:00",
  opening: "09:35",
  midday: "12:00",
  "pre-close": "15:30",
};

/** One option contract, identified the way the API identifies it. */
export interface OptionContract {
  /** OSI-normalised symbol, e.g. "SPY260916C00660000". The API's primary key. */
  readonly osiSymbol: string;
  readonly underlying: string;
  readonly side: OptionSide;
  readonly strike: number;
  /** Expiration as YYYY-MM-DD. */
  readonly expiration: string;
}

/** A quote for one option contract. Prices are per share; multiply by 100 for contract cost. */
export interface OptionQuote {
  readonly osiSymbol: string;
  readonly last: number;
  readonly bid?: number;
  readonly ask?: number;
  readonly volume?: number;
  readonly openInterest?: number;
  /**
   * Quote timestamp as the API reported it. The premarket guard in
   * `analysis.ts` depends on this being the vendor's real timestamp rather
   * than the moment we happened to call — a premarket pull carrying the prior
   * close silently corrupted every Greek in an earlier manual run.
   */
  readonly timestamp?: string;
}

/**
 * Greeks for one contract, as `get_option_greeks` reports them.
 *
 * `theta`, `delta`, `gamma`, `vega` and `rho` are all **per share**.
 * `impliedVolatility` is a ratio (0.42), never the API's "42".
 */
export interface Greeks {
  readonly osiSymbol: string;
  readonly delta: number;
  readonly gamma: number;
  readonly theta: number;
  readonly vega: number;
  readonly rho: number;
  readonly impliedVolatility: number;
}

/** A quote for an underlying: a stock, an ETF, or an index such as VIX. */
export interface UnderlyingQuote {
  readonly symbol: string;
  readonly last: number;
  readonly bid?: number;
  readonly ask?: number;
  readonly previousClose?: number;
  /** Day change as a ratio (0.0545), not the API's "5.45". */
  readonly dayChangeRatio?: number;
  readonly dayHigh?: number;
  readonly dayLow?: number;
  readonly timestamp?: string;
}

/**
 * One side of one strike. `get_option_chain` returns Greeks inline under
 * `optionDetails.greeks`, so a chain pull already carries everything a
 * per-contract Greeks call would — there is no need to follow a chain with
 * `get_option_greeks` for strikes it already covered.
 */
export interface ChainLeg {
  readonly contract: OptionContract;
  readonly quote: OptionQuote;
  readonly greeks?: Greeks;
  /**
   * The vendor's own mid. Kept as reported rather than recomputed, so a
   * disagreement between it and `(bid + ask) / 2` stays visible instead of
   * being silently papered over — `analysis.ts` computes its own mid and
   * compares.
   */
  readonly midPrice?: number;
}

/** One strike's worth of a chain: the call and the put, where each exists. */
export interface ChainRow {
  readonly strike: number;
  readonly call?: ChainLeg;
  readonly put?: ChainLeg;
}

/** A chain snapshot for one underlying and one expiration. */
export interface ChainSnapshot {
  readonly underlying: string;
  readonly expiration: string;
  readonly rows: readonly ChainRow[];
}

/**
 * A catalyst found against a held position or a watchlist name: something
 * dated that could move the price inside the window being checked.
 */
export interface CatalystFlag {
  readonly symbol: string;
  readonly kind: "EARNINGS" | "DIVIDEND" | "SPLIT" | "MACRO";
  /** The date the event lands, YYYY-MM-DD. */
  readonly date: string;
  /** Trading days from the run date. 0 means today. */
  readonly tradingDaysAway: number;
  readonly detail: string;
}

/** Where a candidate came from, so a report can say why it is on the list at all. */
export type CandidateSource = "HOLDING" | "WATCHLIST" | "MARKET_SCAN";

/** A name under consideration, before any analysis or ranking. */
export interface Candidate {
  readonly symbol: string;
  readonly sources: readonly CandidateSource[];
  /** Share of the account, as a ratio, when the name is also a holding. */
  readonly portfolioWeight?: number;
  /** Free-text note from whichever source surfaced it (e.g. "up 8% on volume"). */
  readonly note?: string;
}
