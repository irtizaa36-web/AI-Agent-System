import { roundTo } from "../public-trading/decimal";
import type { PortfolioSnapshot } from "../public-trading/types";
import {
  etClock,
  isWeekendEt,
  worstSeverity,
  type AnalysisFlag,
  type ContractAnalysis,
  type IvTermCheck,
  type MarketClock,
} from "./analysis";
import { partitionMacro } from "./catalysts";
import type { SizedRecommendation, SizingPolicy } from "./recommend";
import { CHECK_IN_SLOTS, SLOT_TARGET_ET, type Candidate, type CatalystFlag, type CheckInSlot, type UnderlyingQuote } from "./types";

/**
 * Assembling one check-in into a value a renderer can print.
 *
 * Pure, like `../public-trading/review.ts`: fetching happens in the session, so
 * every number in a report is reproducible from a saved input file, and the
 * connector's credentials never enter this process.
 *
 * The four slots differ in what they emphasise rather than in what they can
 * hold, so one `MarketReview` shape serves all of them and `slot` decides how
 * it renders. That keeps the "what changed since last check" arithmetic in one
 * place instead of four.
 */

/** What a run could not finish, when it could not finish. */
export interface FailureReport {
  readonly reason: string;
  readonly details: readonly string[];
}

/** Enough of the previous run to compute what moved since. */
export interface PriorRunReference {
  readonly runAt: string;
  readonly slot: CheckInSlot;
  /** Underlying last prices as the previous run saw them, by symbol. */
  readonly underlyingPrices: Readonly<Record<string, number>>;
  /** Symbols the previous run recommended, for a held-or-not-held read. */
  readonly recommendedSymbols?: readonly string[];
}

/** One symbol's move between the previous run and this one. */
export interface PriceDelta {
  readonly symbol: string;
  readonly priorPrice: number;
  readonly currentPrice: number;
  readonly changeRatio: number;
}

export interface MarketReview {
  readonly runAt: string;
  readonly slot: CheckInSlot;
  readonly clock: MarketClock;
  readonly accountId: string;
  /** Minutes until the 16:00 ET close. Negative after it. */
  readonly minutesToClose: number;
  readonly snapshot?: PortfolioSnapshot;
  /** The primary volatility gauge. Pulled every run, per the operator's standing instruction. */
  readonly vix?: UnderlyingQuote;
  readonly underlyings: readonly UnderlyingQuote[];
  readonly candidates: readonly Candidate[];
  readonly macroCatalysts: readonly CatalystFlag[];
  readonly symbolCatalysts: readonly CatalystFlag[];
  readonly ivTermChecks: readonly IvTermCheck[];
  readonly contractAnalyses: readonly ContractAnalysis[];
  readonly recommendations: readonly SizedRecommendation[];
  readonly sizing: SizingPolicy;
  readonly deltas: readonly PriceDelta[];
  readonly prior?: PriorRunReference;
  /**
   * Free-text notes from the session: which news sources were checked, what a
   * macro-odds re-check found, anything a human should know that is not a
   * number. Rendered verbatim.
   */
  readonly notes: readonly string[];
  /** Present when the run could not complete. A report with this set says so first. */
  readonly incomplete?: FailureReport;
  /** Aggregate of every flag the run raised, for the header summary. */
  readonly flags: readonly AnalysisFlag[];
}

export interface BuildMarketReviewInput {
  readonly runAt: string;
  readonly slot: CheckInSlot;
  readonly accountId: string;
  readonly snapshot?: PortfolioSnapshot;
  readonly vix?: UnderlyingQuote;
  readonly underlyings?: readonly UnderlyingQuote[];
  readonly candidates?: readonly Candidate[];
  readonly catalysts?: readonly CatalystFlag[];
  readonly ivTermChecks?: readonly IvTermCheck[];
  readonly contractAnalyses?: readonly ContractAnalysis[];
  readonly recommendations?: readonly SizedRecommendation[];
  readonly sizing: SizingPolicy;
  readonly prior?: PriorRunReference;
  readonly notes?: readonly string[];
  readonly incomplete?: FailureReport;
}

const CLOSE_MINUTES_ET = 16 * 60;

/** Asserts a slot string came from the known set, since it drives which report renders. */
export function parseCheckInSlot(value: string): CheckInSlot {
  const normalised = value.trim().toLowerCase();
  const match = CHECK_IN_SLOTS.find((slot) => slot === normalised);
  if (match === undefined) {
    throw new Error(`Unknown check-in slot ${JSON.stringify(value)}. Expected one of: ${CHECK_IN_SLOTS.join(", ")}`);
  }
  return match;
}

/** Computes per-symbol moves against the previous run. Symbols absent from either side are skipped. */
export function priceDeltas(
  underlyings: readonly UnderlyingQuote[],
  prior: PriorRunReference | undefined,
): readonly PriceDelta[] {
  if (prior === undefined) return [];
  const deltas: PriceDelta[] = [];
  for (const quote of underlyings) {
    const priorPrice = prior.underlyingPrices[quote.symbol];
    if (priorPrice === undefined || priorPrice === 0) continue;
    deltas.push({
      symbol: quote.symbol,
      priorPrice,
      currentPrice: quote.last,
      changeRatio: roundTo(quote.last / priorPrice - 1, 6),
    });
  }
  return deltas.sort((a, b) => Math.abs(b.changeRatio) - Math.abs(a.changeRatio));
}

/**
 * Flags about the run itself rather than any one contract.
 *
 * The slot-timing check is the one that matters: a run firing well away from its
 * target ET time is usually a scheduling or DST problem, and the resulting
 * numbers describe a different moment than the report claims to. A weekend run
 * is flagged too, since the schedule fires on a clock that does not know about
 * market holidays.
 */
export function runLevelFlags(slot: CheckInSlot, clock: MarketClock): readonly AnalysisFlag[] {
  const flags: AnalysisFlag[] = [];

  if (isWeekendEt(clock)) {
    flags.push({
      code: "NON_TRADING_DAY",
      severity: "BLOCK",
      message: `Run fired on a weekend (${clock.etDate} ET). No live market; treat every figure as stale.`,
    });
  }

  const [targetHour = "0", targetMinute = "0"] = SLOT_TARGET_ET[slot].split(":");
  const targetMinutes = Number(targetHour) * 60 + Number(targetMinute);
  const [actualHour = "0", actualMinute = "0"] = clock.etTime.split(":");
  const actualMinutes = Number(actualHour) * 60 + Number(actualMinute);
  const drift = actualMinutes - targetMinutes;

  if (Math.abs(drift) > 20) {
    flags.push({
      code: "SLOT_TIME_DRIFT",
      severity: "WARN",
      message:
        `The ${slot} check-in targets ${SLOT_TARGET_ET[slot]} ET but ran at ${clock.etTime} ET ` +
        `(${drift > 0 ? "+" : ""}${drift} min). If this is not a deliberate manual run, check the schedule — ` +
        "an hour of drift usually means a UTC cron that did not follow a DST change.",
    });
  }

  return flags;
}

/** Assembles a `MarketReview` from already-fetched pieces. Pure — no I/O. */
export function buildMarketReview(input: BuildMarketReviewInput): MarketReview {
  const clock = etClock(input.runAt);
  const underlyings = input.underlyings ?? [];
  const { macro, perSymbol } = partitionMacro(input.catalysts ?? []);
  const contractAnalyses = input.contractAnalyses ?? [];
  const ivTermChecks = input.ivTermChecks ?? [];

  const [closeHour = "0", closeMinute = "0"] = clock.etTime.split(":");
  const minutesToClose = CLOSE_MINUTES_ET - (Number(closeHour) * 60 + Number(closeMinute));

  const flags: AnalysisFlag[] = [
    ...runLevelFlags(input.slot, clock),
    ...contractAnalyses.flatMap((analysis) => analysis.flags),
    ...ivTermChecks.flatMap((check) => check.flags),
  ];

  return {
    runAt: input.runAt,
    slot: input.slot,
    clock,
    accountId: input.accountId,
    minutesToClose,
    ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
    ...(input.vix === undefined ? {} : { vix: input.vix }),
    underlyings,
    candidates: input.candidates ?? [],
    macroCatalysts: macro,
    symbolCatalysts: perSymbol,
    ivTermChecks,
    contractAnalyses,
    recommendations: input.recommendations ?? [],
    sizing: input.sizing,
    deltas: priceDeltas(underlyings, input.prior),
    ...(input.prior === undefined ? {} : { prior: input.prior }),
    notes: input.notes ?? [],
    ...(input.incomplete === undefined ? {} : { incomplete: input.incomplete }),
    flags,
  };
}

/** The most severe thing the run found, for the report header. */
export function reviewSeverity(review: MarketReview): ReturnType<typeof worstSeverity> {
  return worstSeverity(review.flags);
}

/** The underlying-price map this run should hand to the next one as its prior reference. */
export function priorReferenceFrom(review: MarketReview): PriorRunReference {
  return {
    runAt: review.runAt,
    slot: review.slot,
    underlyingPrices: Object.fromEntries(review.underlyings.map((quote) => [quote.symbol, quote.last])),
    recommendedSymbols: review.recommendations.map((recommendation) => recommendation.symbol),
  };
}
