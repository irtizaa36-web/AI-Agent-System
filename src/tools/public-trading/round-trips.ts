import { roundTo } from "./decimal";
import type { Transaction } from "./types";

/**
 * Reconstructing closed round trips from transaction history, with the
 * realised P/L and cost drag of each.
 *
 * This is the part of the system that uses *realised* rather than hypothetical
 * data, which `.agents/skills/crypto-signal-eval/SKILL.md` ("Auditing a live
 * agent") calls out as often the more valuable half of the work. It reports
 * what the record shows and nothing more: it never infers the trading rules
 * behind the trades and then evaluates the inference as if it were the rules.
 */

/** One fill contributing to a round trip. */
export interface Fill {
  readonly transactionId: string;
  readonly timestamp: string;
  readonly quantity: number;
  /** Cash actually moved, fees and spread included. */
  readonly netAmount: number;
  /** Gross value at the quoted execution price. */
  readonly principalAmount: number;
  readonly fees: number;
}

/** A buy matched against a later sell of the same symbol. */
export interface RoundTrip {
  readonly symbol: string;
  readonly securityType: string;
  readonly quantity: number;
  readonly openedAt: string;
  readonly closedAt: string;
  /** Hours held, buy fill to sell fill. */
  readonly holdHours: number;
  /** Cash paid to open the matched quantity, fees and spread included. */
  readonly costIn: number;
  /** Cash received on closing the matched quantity, fees and spread deducted. */
  readonly proceedsOut: number;
  /** `proceedsOut - costIn`. Negative is a loss. */
  readonly realisedPl: number;
  /** Realised P/L as a ratio of `costIn`. */
  readonly realisedPlRatio: number;
  /** Execution price per unit on the way in, from principal (pre-cost). */
  readonly entryPrice: number;
  readonly exitPrice: number;
  /** Ratio the *price* moved, which is what a backtest would have modelled. */
  readonly priceMoveRatio: number;
  /**
   * Total spread, markup and fees across both legs, as a ratio of the money
   * put in. This is the round-trip cost drag: the gap between what the price
   * did and what the position did.
   */
  readonly costDragRatio: number;
  readonly costDragDollars: number;
  readonly buyTransactionIds: readonly string[];
  readonly sellTransactionId: string;
}

/**
 * Cost actually borne on one fill, in dollars.
 *
 * `principalAmount` is the gross at the quoted execution price;
 * `netAmount` is the cash that really moved. On a buy the net is *more*
 * negative than the principal, on a sell the net is *less* positive — the gap
 * is spread and markup, and it shows up even when the `fees` field reads
 * "0.00" (the UNI buy of 2026-09-08 moved $37.22 of cash on $37.00 of
 * principal with zero stated fees). Measuring drag here, per fill, is exact,
 * where inferring it from price-move-versus-P/L is an estimate.
 */
export function fillCost(fill: Fill, side: "BUY" | "SELL"): number {
  const net = Math.abs(fill.netAmount);
  const principal = Math.abs(fill.principalAmount);
  if (principal === 0) return Math.abs(fill.fees);
  return side === "BUY" ? net - principal : principal - net;
}

function isTrade(transaction: Transaction): boolean {
  return transaction.type === "TRADE" && typeof transaction.symbol === "string" && transaction.symbol !== "";
}

function hoursBetween(from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return (end - start) / 3_600_000;
}

interface OpenLot {
  readonly fill: Fill;
  remainingQuantity: number;
}

/**
 * Matches buys to sells FIFO, per symbol, and returns one `RoundTrip` per sell.
 *
 * FIFO is the right default here rather than a guess at the broker's own lot
 * selection: Public applies its default lot matching unless a seller passes
 * explicit tax-lot instructions, and this system never places orders, so it
 * has no instructions to reconcile against. Where a sell is larger than the
 * open lots on file — which happens whenever history is fetched from a start
 * date after the position was opened — the unmatched quantity is dropped
 * rather than guessed at, and the round trip covers only the matched part.
 * That understates volume but never invents a P/L number.
 */
export function matchRoundTrips(transactions: readonly Transaction[]): readonly RoundTrip[] {
  const trades = transactions
    .filter(isTrade)
    .slice()
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const openLots = new Map<string, OpenLot[]>();
  const roundTrips: RoundTrip[] = [];

  for (const trade of trades) {
    const symbol = trade.symbol as string;
    const fill: Fill = {
      transactionId: trade.id,
      timestamp: trade.timestamp,
      quantity: Math.abs(trade.quantity),
      netAmount: trade.netAmount,
      principalAmount: trade.principalAmount,
      fees: trade.fees,
    };

    if (trade.side === "BUY") {
      const lots = openLots.get(symbol) ?? [];
      lots.push({ fill, remainingQuantity: fill.quantity });
      openLots.set(symbol, lots);
      continue;
    }
    if (trade.side !== "SELL" || fill.quantity === 0) continue;

    const lots = openLots.get(symbol) ?? [];
    let quantityToMatch = fill.quantity;
    let costIn = 0;
    let entryPrincipal = 0;
    let buyCost = 0;
    let openedAt: string | undefined;
    const buyTransactionIds: string[] = [];

    while (quantityToMatch > 1e-12 && lots.length > 0) {
      const lot = lots[0] as OpenLot;
      const matched = Math.min(lot.remainingQuantity, quantityToMatch);
      const share = matched / lot.fill.quantity;
      costIn += Math.abs(lot.fill.netAmount) * share;
      entryPrincipal += Math.abs(lot.fill.principalAmount) * share;
      buyCost += fillCost(lot.fill, "BUY") * share;
      openedAt ??= lot.fill.timestamp;
      if (!buyTransactionIds.includes(lot.fill.transactionId)) buyTransactionIds.push(lot.fill.transactionId);
      lot.remainingQuantity -= matched;
      quantityToMatch -= matched;
      if (lot.remainingQuantity <= 1e-12) lots.shift();
    }
    openLots.set(symbol, lots);

    const matchedQuantity = fill.quantity - quantityToMatch;
    if (matchedQuantity <= 1e-12 || openedAt === undefined || costIn === 0) continue;

    // Only the matched share of the sell counts, so a partial close is
    // measured against the cost of exactly the quantity it closed.
    const matchedShare = matchedQuantity / fill.quantity;
    const proceedsOut = Math.abs(fill.netAmount) * matchedShare;
    const exitPrincipal = Math.abs(fill.principalAmount) * matchedShare;
    const sellCost = fillCost(fill, "SELL") * matchedShare;

    const realisedPl = proceedsOut - costIn;
    const entryPrice = entryPrincipal / matchedQuantity;
    const exitPrice = exitPrincipal / matchedQuantity;
    const totalCost = buyCost + sellCost;

    roundTrips.push({
      symbol,
      securityType: trade.securityType ?? "",
      quantity: roundTo(matchedQuantity, 8),
      openedAt,
      closedAt: fill.timestamp,
      holdHours: roundTo(hoursBetween(openedAt, fill.timestamp), 2),
      costIn: roundTo(costIn, 4),
      proceedsOut: roundTo(proceedsOut, 4),
      realisedPl: roundTo(realisedPl, 4),
      realisedPlRatio: costIn === 0 ? 0 : realisedPl / costIn,
      entryPrice: roundTo(entryPrice, 8),
      exitPrice: roundTo(exitPrice, 8),
      priceMoveRatio: entryPrice === 0 ? 0 : (exitPrice - entryPrice) / entryPrice,
      costDragRatio: entryPrincipal === 0 ? 0 : totalCost / entryPrincipal,
      costDragDollars: roundTo(totalCost, 4),
      buyTransactionIds,
      sellTransactionId: fill.transactionId,
    });
  }

  return roundTrips;
}

/** Aggregate statistics over a set of round trips. */
export interface RoundTripSummary {
  readonly count: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRate: number;
  readonly totalRealisedPl: number;
  readonly meanRealisedPlRatio: number;
  readonly totalCostDragDollars: number;
  /** Dollar-weighted, so a large trade's drag is not averaged away by a tiny one. */
  readonly meanCostDragRatio: number;
  readonly medianHoldHours: number;
}

export function summariseRoundTrips(roundTrips: readonly RoundTrip[]): RoundTripSummary {
  if (roundTrips.length === 0) {
    return {
      count: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalRealisedPl: 0,
      meanRealisedPlRatio: 0,
      totalCostDragDollars: 0,
      meanCostDragRatio: 0,
      medianHoldHours: 0,
    };
  }
  const wins = roundTrips.filter((trip) => trip.realisedPl > 0).length;
  const totalRealisedPl = roundTrips.reduce((sum, trip) => sum + trip.realisedPl, 0);
  const totalCostDragDollars = roundTrips.reduce((sum, trip) => sum + trip.costDragDollars, 0);
  const totalCostIn = roundTrips.reduce((sum, trip) => sum + trip.costIn, 0);
  const holds = roundTrips.map((trip) => trip.holdHours).sort((a, b) => a - b);
  const middle = Math.floor(holds.length / 2);
  const medianHoldHours =
    holds.length % 2 === 0 ? ((holds[middle - 1] as number) + (holds[middle] as number)) / 2 : (holds[middle] as number);

  return {
    count: roundTrips.length,
    wins,
    losses: roundTrips.length - wins,
    winRate: wins / roundTrips.length,
    totalRealisedPl: roundTo(totalRealisedPl, 2),
    meanRealisedPlRatio: roundTrips.reduce((sum, trip) => sum + trip.realisedPlRatio, 0) / roundTrips.length,
    totalCostDragDollars: roundTo(totalCostDragDollars, 4),
    meanCostDragRatio: totalCostIn === 0 ? 0 : totalCostDragDollars / totalCostIn,
    medianHoldHours: roundTo(medianHoldHours, 2),
  };
}

/** Round trips closed strictly after `watermark` — "since the last run". */
export function roundTripsClosedAfter(roundTrips: readonly RoundTrip[], watermark?: string): readonly RoundTrip[] {
  if (watermark === undefined) return roundTrips;
  const cutoff = Date.parse(watermark);
  if (!Number.isFinite(cutoff)) return roundTrips;
  return roundTrips.filter((trip) => Date.parse(trip.closedAt) > cutoff);
}
