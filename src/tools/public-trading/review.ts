import type { PublicTradingClient } from "./client";
import { ROUND_TRIP_COST_BASELINE, type DraftOutcome } from "./draft";
import { roundTo } from "./decimal";
import {
  analyseConcentration,
  analyseOrderFeasibility,
  DEFAULT_CONCENTRATION_THRESHOLDS,
  type ConcentrationReport,
  type ConcentrationThresholds,
  type OrderFeasibilityReport,
} from "./portfolio-analysis";
import {
  matchRoundTrips,
  roundTripsClosedAfter,
  summariseRoundTrips,
  type RoundTrip,
  type RoundTripSummary,
} from "./round-trips";
import { proposeDrafts, type DraftCandidate } from "./draft";
import type { PortfolioSnapshot, Transaction } from "./types";

/**
 * Assembling one run's review: the five things requirement 5 asks for
 * (portfolio snapshot, closed-trade P/L since the last run, cost drag,
 * concentration by position, and any drafted trades with rationale), plus the
 * order-feasibility check the audit made necessary.
 *
 * This module is pure: it takes data in and returns a `Review` value. Fetching
 * and file writing live in `run.ts`, which keeps every number here testable
 * without a network or a filesystem.
 */

/** How this run's realised cost drag compares to the briefing's assumption. */
export interface CostDragReport {
  /** The assumption the backtest work is calibrated on, from BRIEFING.md. */
  readonly baseline: number;
  /** Dollar-weighted realised drag across every closed round trip in the window. */
  readonly realisedRoundTrip: number;
  readonly realisedDollars: number;
  readonly sampleSize: number;
  /** Positive when the account is paying more than the baseline assumes. */
  readonly deltaVsBaseline: number;
  readonly note: string;
}

export interface Review {
  readonly runAt: string;
  readonly accountId: string;
  /** Latest transaction timestamp this run accounted for. The next run's "since". */
  readonly watermark?: string;
  /** The previous run's watermark, or undefined on the first run. */
  readonly previousWatermark?: string;
  readonly snapshot: PortfolioSnapshot;
  readonly closedSinceLastRun: readonly RoundTrip[];
  readonly closedSinceLastRunSummary: RoundTripSummary;
  readonly windowSummary: RoundTripSummary;
  readonly costDrag: CostDragReport;
  readonly concentration: ConcentrationReport;
  readonly orderFeasibility: OrderFeasibilityReport;
  readonly drafts: DraftOutcome;
  /** The history window this run pulled, for reproducibility. */
  readonly historyWindow: { readonly start?: string; readonly end?: string };
}

export interface BuildReviewInput {
  readonly runAt: string;
  readonly accountId: string;
  readonly snapshot: PortfolioSnapshot;
  readonly transactions: readonly Transaction[];
  readonly previousWatermark?: string;
  readonly drafts: DraftOutcome;
  readonly historyWindow?: { readonly start?: string; readonly end?: string };
  readonly costBaseline?: number;
  readonly thresholds?: ConcentrationThresholds;
}

function latestTimestamp(transactions: readonly Transaction[]): string | undefined {
  let latest: number | undefined;
  let latestIso: string | undefined;
  for (const transaction of transactions) {
    const parsed = Date.parse(transaction.timestamp);
    if (!Number.isFinite(parsed)) continue;
    if (latest === undefined || parsed > latest) {
      latest = parsed;
      latestIso = transaction.timestamp;
    }
  }
  return latestIso;
}

function buildCostDragReport(
  windowSummary: RoundTripSummary,
  baseline: number,
): CostDragReport {
  const realised = windowSummary.meanCostDragRatio;
  const delta = realised - baseline;

  let note: string;
  if (windowSummary.count === 0) {
    note =
      "No closed round trips in this window, so realised drag could not be measured. The baseline stands unrevised.";
  } else if (delta > 0.001) {
    note =
      `Realised drag is running ${(delta * 100).toFixed(2)} points above the ${(baseline * 100).toFixed(2)}% ` +
      `baseline across ${windowSummary.count} closed round trip(s). If this holds as the sample grows, the ` +
      "baseline used in backtests should be revised upward — a signal must clear the cost it actually pays.";
  } else if (delta < -0.001) {
    note =
      `Realised drag is running ${(Math.abs(delta) * 100).toFixed(2)} points below the ` +
      `${(baseline * 100).toFixed(2)}% baseline across ${windowSummary.count} closed round trip(s). Keep the ` +
      "baseline where it is until the sample is larger; the conservative assumption costs nothing.";
  } else {
    note = `Realised drag matches the ${(baseline * 100).toFixed(2)}% baseline across ${windowSummary.count} closed round trip(s).`;
  }

  return {
    baseline,
    realisedRoundTrip: realised,
    realisedDollars: windowSummary.totalCostDragDollars,
    sampleSize: windowSummary.count,
    deltaVsBaseline: roundTo(delta, 6),
    note,
  };
}

/** Assembles a `Review` from already-fetched data. Pure — no I/O. */
export function buildReview(input: BuildReviewInput): Review {
  const baseline = input.costBaseline ?? ROUND_TRIP_COST_BASELINE;
  const allRoundTrips = matchRoundTrips(input.transactions);
  const closedSinceLastRun = roundTripsClosedAfter(allRoundTrips, input.previousWatermark);
  const watermark = latestTimestamp(input.transactions);

  return {
    runAt: input.runAt,
    accountId: input.accountId,
    ...(watermark === undefined ? {} : { watermark }),
    ...(input.previousWatermark === undefined ? {} : { previousWatermark: input.previousWatermark }),
    snapshot: input.snapshot,
    closedSinceLastRun,
    closedSinceLastRunSummary: summariseRoundTrips(closedSinceLastRun),
    windowSummary: summariseRoundTrips(allRoundTrips),
    costDrag: buildCostDragReport(summariseRoundTrips(allRoundTrips), baseline),
    concentration: analyseConcentration(input.snapshot, input.thresholds ?? DEFAULT_CONCENTRATION_THRESHOLDS),
    orderFeasibility: analyseOrderFeasibility(input.snapshot),
    drafts: input.drafts,
    historyWindow: input.historyWindow ?? {},
  };
}

export interface RunReviewOptions {
  readonly accountId: string;
  readonly client: PublicTradingClient;
  /** ISO timestamp for the run. Injected so tests and reruns are deterministic. */
  readonly runAt?: string;
  readonly previousWatermark?: string;
  /** How far back to pull history. Defaults to 30 days before the run. */
  readonly historyStart?: string;
  readonly historyEnd?: string;
  /**
   * Trade ideas from registered signals. Empty in normal operation: the
   * registry has no validated signals, so nothing generates candidates.
   */
  readonly candidates?: readonly DraftCandidate[];
  readonly costBaseline?: number;
  readonly thresholds?: ConcentrationThresholds;
}

const DEFAULT_HISTORY_DAYS = 30;

/**
 * Fetches everything one run needs and assembles the review.
 *
 * Deliberately does not call `get_price_history`: with no validated signal
 * there is nothing to evaluate bars against, and the skill's token-efficiency
 * rule is that price history goes to disk for `backtest.py`, never into an
 * agent's context. `writePriceHistoryCsv` is the path for that when signal work
 * resumes.
 */
export async function runReview(options: RunReviewOptions): Promise<Review> {
  const runAt = options.runAt ?? new Date().toISOString();
  const historyStart =
    options.historyStart ?? new Date(Date.parse(runAt) - DEFAULT_HISTORY_DAYS * 86_400_000).toISOString();

  const snapshot = await options.client.getPortfolio(options.accountId);
  const transactions = await options.client.getHistory(options.accountId, {
    start: historyStart,
    ...(options.historyEnd ? { end: options.historyEnd } : {}),
    pageSize: 100,
  });

  const drafts = await proposeDrafts(options.candidates ?? [], {
    accountId: options.accountId,
    snapshot,
    client: options.client,
    ...(options.costBaseline === undefined ? {} : { costBaseline: options.costBaseline }),
  });

  return buildReview({
    runAt,
    accountId: options.accountId,
    snapshot,
    transactions,
    ...(options.previousWatermark === undefined ? {} : { previousWatermark: options.previousWatermark }),
    drafts,
    historyWindow: { start: historyStart, ...(options.historyEnd ? { end: options.historyEnd } : {}) },
    ...(options.costBaseline === undefined ? {} : { costBaseline: options.costBaseline }),
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
  });
}
