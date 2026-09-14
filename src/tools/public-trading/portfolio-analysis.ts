import { roundTo } from "./decimal";
import type { OpenOrder, PortfolioSnapshot, Position } from "./types";

/**
 * Concentration and order-feasibility checks over a portfolio snapshot.
 *
 * Both come straight from the audit findings in `BRIEFING.md`: 16 open limit
 * buys totalling ~$57 notional were queued against $14.91 of buying power, and
 * two mid-cap alts (DOT and AVAX) were ~38% of a $367 account. These functions
 * make both conditions measurable on every run instead of something a human
 * has to notice.
 *
 * The thresholds below are *reporting* thresholds — they decide what gets
 * flagged for a human to look at. They are not risk limits, and nothing in
 * this system acts on them.
 */

export interface ConcentrationThresholds {
  /** Flag any single position at or above this share of total account value. */
  readonly singlePosition: number;
  /** Flag when the two largest positions together reach this share. */
  readonly topTwoCombined: number;
  /** Flag when one asset class reaches this share of the account. */
  readonly assetClass: number;
}

/**
 * Defaults calibrated against the audited account rather than picked round:
 * DOT alone was 14.5% and DOT+AVAX 38% of a $367 account, so 20% singles /
 * 35% top-two sit just above the observed state and will fire when it worsens.
 */
export const DEFAULT_CONCENTRATION_THRESHOLDS: ConcentrationThresholds = {
  singlePosition: 0.2,
  topTwoCombined: 0.35,
  assetClass: 0.6,
};

export interface ConcentrationEntry {
  readonly symbol: string;
  readonly name: string;
  readonly instrumentType: string;
  readonly value: number;
  readonly shareOfAccount: number;
  readonly flagged: boolean;
}

export interface ConcentrationReport {
  readonly totalAccountValue: number;
  /** Every position, largest first. */
  readonly positions: readonly ConcentrationEntry[];
  readonly topTwoCombinedShare: number;
  readonly assetClassShares: readonly { readonly type: string; readonly share: number; readonly value: number }[];
  /** Plain-language descriptions of every threshold breach. Empty when nothing is flagged. */
  readonly flags: readonly string[];
}

export function analyseConcentration(
  snapshot: PortfolioSnapshot,
  thresholds: ConcentrationThresholds = DEFAULT_CONCENTRATION_THRESHOLDS,
): ConcentrationReport {
  const total = snapshot.totalAccountValue;
  const sorted = [...snapshot.positions].sort((a, b) => b.currentValue - a.currentValue);

  const positions: ConcentrationEntry[] = sorted.map((position: Position) => {
    // Recomputed from dollars rather than trusting the API's percentOfPortfolio,
    // so the shares in a review always sum against the same denominator.
    const shareOfAccount = total === 0 ? 0 : position.currentValue / total;
    return {
      symbol: position.symbol,
      name: position.name,
      instrumentType: position.instrumentType,
      value: position.currentValue,
      shareOfAccount,
      flagged: shareOfAccount >= thresholds.singlePosition,
    };
  });

  const topTwoCombinedShare = positions.slice(0, 2).reduce((sum, entry) => sum + entry.shareOfAccount, 0);

  const byClass = new Map<string, number>();
  for (const position of snapshot.positions) {
    byClass.set(position.instrumentType, (byClass.get(position.instrumentType) ?? 0) + position.currentValue);
  }
  const assetClassShares = [...byClass.entries()]
    .map(([type, value]) => ({ type, value: roundTo(value, 2), share: total === 0 ? 0 : value / total }))
    .sort((a, b) => b.share - a.share);

  const flags: string[] = [];
  for (const entry of positions.filter((candidate) => candidate.flagged)) {
    flags.push(
      `${entry.symbol} is ${(entry.shareOfAccount * 100).toFixed(1)}% of the account, at or above the ${(
        thresholds.singlePosition * 100
      ).toFixed(0)}% single-position reporting threshold.`,
    );
  }
  if (positions.length >= 2 && topTwoCombinedShare >= thresholds.topTwoCombined) {
    const [first, second] = positions as [ConcentrationEntry, ConcentrationEntry];
    flags.push(
      `${first.symbol} and ${second.symbol} together are ${(topTwoCombinedShare * 100).toFixed(1)}% of the account, ` +
        `at or above the ${(thresholds.topTwoCombined * 100).toFixed(0)}% top-two threshold.`,
    );
  }
  for (const bucket of assetClassShares) {
    if (bucket.share >= thresholds.assetClass) {
      flags.push(
        `${bucket.type} holdings are ${(bucket.share * 100).toFixed(1)}% of the account, at or above the ${(
          thresholds.assetClass * 100
        ).toFixed(0)}% asset-class threshold.`,
      );
    }
  }

  return { totalAccountValue: total, positions, topTwoCombinedShare, assetClassShares, flags };
}

export interface OrderFeasibilityReport {
  readonly buyingPower: number;
  readonly openBuyOrderCount: number;
  /** Total notional the open buy orders would consume if they all filled. */
  readonly committedNotional: number;
  /** `committedNotional - buyingPower`. Positive means orders exceed cash. */
  readonly shortfall: number;
  /** True when queued buys cannot all fill against available cash. */
  readonly infeasible: boolean;
  /** Orders that cannot fill even individually against buying power. */
  readonly individuallyUnfillable: readonly OpenOrder[];
  readonly notes: readonly string[];
}

/**
 * Compares queued buy orders against `buyingPower`.
 *
 * The briefing's finding was that most of a batch of queued limit buys could
 * not fill, and that it was unclear whether the placing agent ever registered
 * the failures. This reports the arithmetic. It does not claim to know why the
 * orders are there or whose they are — the existing Public.com Agent's logic is
 * not visible over any API, and this system does not attempt to control it.
 */
export function analyseOrderFeasibility(snapshot: PortfolioSnapshot): OrderFeasibilityReport {
  const openBuys = snapshot.openOrders.filter(
    (order) => order.side === "BUY" && order.status !== "FILLED" && order.status !== "CANCELLED",
  );
  const committedNotional = roundTo(
    openBuys.reduce((sum, order) => sum + order.notionalValue, 0),
    2,
  );
  const shortfall = roundTo(committedNotional - snapshot.buyingPower, 2);
  const individuallyUnfillable = openBuys.filter((order) => order.notionalValue > snapshot.buyingPower);

  const notes: string[] = [];
  if (shortfall > 0) {
    notes.push(
      `${openBuys.length} open buy order(s) totalling $${committedNotional.toFixed(2)} are queued against ` +
        `$${snapshot.buyingPower.toFixed(2)} of buying power — a shortfall of $${shortfall.toFixed(2)}. ` +
        `They cannot all fill.`,
    );
  }
  if (individuallyUnfillable.length > 0) {
    notes.push(
      `${individuallyUnfillable.length} of those order(s) exceed buying power on their own and cannot fill at all ` +
        `unless cash increases: ${individuallyUnfillable.map((order) => order.symbol).join(", ")}.`,
    );
  }
  if (notes.length === 0 && openBuys.length > 0) {
    notes.push(
      `${openBuys.length} open buy order(s) totalling $${committedNotional.toFixed(2)} fit within ` +
        `$${snapshot.buyingPower.toFixed(2)} of buying power.`,
    );
  }

  return {
    buyingPower: snapshot.buyingPower,
    openBuyOrderCount: openBuys.length,
    committedNotional,
    shortfall,
    infeasible: shortfall > 0,
    individuallyUnfillable,
    notes,
  };
}
