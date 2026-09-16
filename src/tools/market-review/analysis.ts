import { roundTo } from "../public-trading/decimal";
import type { ChainLeg, ChainSnapshot, OptionContract, OptionSide } from "./types";

/**
 * The option math every report is built from, plus the data-quality guards that
 * decide whether the math is worth printing at all.
 *
 * Two deliberate choices run through this file:
 *
 * 1. **Expiration-value framing, not Greeks extrapolation.** "Move needed for
 *    2×" and "move needed to expire worthless" are computed from intrinsic
 *    value at expiration — for a call, value is `max(0, S − K)` — which is
 *    exact arithmetic rather than a delta-based guess that decays the moment
 *    the underlying moves. For 0DTE, where there is no time left to model,
 *    this is also the only framing that means anything.
 *
 * 2. **Bad data is flagged, never silently repaired.** Live chains really do
 *    return `impliedVolatility: 0` on deep-ITM strikes, `bid: 0.00` on
 *    untradeable ones, and a `last` print from days ago next to a current
 *    bid/ask. Each of those becomes a flag on the output. Nothing here
 *    substitutes a plausible number for a missing one, because a plausible
 *    wrong number is worse than a visible gap
 *    (`.agents/skills/options-trading-eval/SKILL.md`, "Prime directive").
 */

/** Regular-session open and close, ET. */
export const MARKET_OPEN_ET = { hour: 9, minute: 30 } as const;
export const MARKET_CLOSE_ET = { hour: 16, minute: 0 } as const;

/** A spread wider than this share of mid earns a liquidity warning. */
export const WIDE_SPREAD_RATIO = 0.05;

/** A spread wider than this is a hard warning: entry cost alone is a large share of the premium. */
export const SEVERE_SPREAD_RATIO = 0.25;

/** IV at the same strike differing by more than this factor across adjacent expirations is treated as an artifact. */
export const IV_TERM_ANOMALY_FACTOR = 2;

/** A `last` print older than this many minutes, while bid/ask are current, is stale. */
export const STALE_LAST_MINUTES = 60;

export type FlagSeverity = "INFO" | "WARN" | "BLOCK";

/**
 * One thing worth saying about a contract's data or shape. `BLOCK` means the
 * numbers should not be acted on at all — a premarket quote or a strike with no
 * bid — rather than merely being caveated.
 */
export interface AnalysisFlag {
  readonly code: string;
  readonly severity: FlagSeverity;
  readonly message: string;
}

export type MarketSession = "PREMARKET" | "OPEN" | "AFTER_HOURS";

/** Where a timestamp falls in the ET trading day. */
export interface MarketClock {
  /** Calendar date in ET, YYYY-MM-DD — not the UTC date, which rolls over mid-session. */
  readonly etDate: string;
  /** Wall-clock time in ET, HH:MM. */
  readonly etTime: string;
  /** Minutes relative to the 09:30 ET open. Negative before the bell. */
  readonly minutesSinceOpen: number;
  readonly session: MarketSession;
  /** ET weekday, 0 = Sunday. Weekend runs are not trading days regardless of session maths. */
  readonly etWeekday: number;
}

const ET_TIME_ZONE = "America/New_York";

/**
 * Converts an instant to ET wall-clock parts.
 *
 * Uses `Intl` with an IANA zone rather than a fixed −4/−5 offset, so the DST
 * transition is handled by the platform instead of by arithmetic that would be
 * wrong for several weeks a year. Node 22 ships full ICU, and this keeps the
 * module free of a timezone dependency (ADR 0002).
 */
export function etClock(iso: string): MarketClock {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`Not a parseable timestamp: ${JSON.stringify(iso)}`);
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(instant);

  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  // `hour12: false` can render midnight as "24" in some ICU versions.
  const hour = Number(lookup("hour")) % 24;
  const minute = Number(lookup("minute"));
  const etDate = `${lookup("year")}-${lookup("month")}-${lookup("day")}`;
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const etWeekday = Math.max(0, weekdayNames.indexOf(lookup("weekday")));

  const minutesSinceOpen = hour * 60 + minute - (MARKET_OPEN_ET.hour * 60 + MARKET_OPEN_ET.minute);
  const minutesSinceClose = hour * 60 + minute - (MARKET_CLOSE_ET.hour * 60 + MARKET_CLOSE_ET.minute);
  const session: MarketSession =
    minutesSinceOpen < 0 ? "PREMARKET" : minutesSinceClose >= 0 ? "AFTER_HOURS" : "OPEN";

  return {
    etDate,
    etTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    minutesSinceOpen,
    session,
    etWeekday,
  };
}

/** True for Saturday and Sunday in ET. Holidays are not knowable from a timestamp alone. */
export function isWeekendEt(clock: MarketClock): boolean {
  return clock.etWeekday === 0 || clock.etWeekday === 6;
}

/**
 * The premarket guard.
 *
 * A quote pulled before 09:30 ET carries the prior close while the underlying
 * has already moved, which silently corrupts every derived Greek and every
 * "move needed" figure. Rather than refusing outright — the 09:00 pre-open
 * check-in is a deliberate, wanted run — this returns a `BLOCK` flag so the
 * report prints the caveat prominently and the reader knows the numbers are
 * pre-open reference values, not tradeable ones.
 */
export function quoteFreshnessFlags(quoteTimestamp: string | undefined, runAt: string): readonly AnalysisFlag[] {
  const flags: AnalysisFlag[] = [];
  if (quoteTimestamp === undefined) {
    flags.push({
      code: "NO_QUOTE_TIMESTAMP",
      severity: "WARN",
      message: "The quote carried no timestamp, so its freshness could not be verified.",
    });
    return flags;
  }

  const quoteClock = etClock(quoteTimestamp);
  if (quoteClock.session === "PREMARKET") {
    flags.push({
      code: "PREMARKET_QUOTE",
      severity: "BLOCK",
      message:
        `Quote is timestamped ${quoteClock.etTime} ET (before the 09:30 open), so it reflects the prior ` +
        "close rather than a live market. Treat every figure below as a pre-open reference, not a tradeable price.",
    });
  }

  const ageMinutes = (new Date(runAt).getTime() - new Date(quoteTimestamp).getTime()) / 60_000;
  if (ageMinutes > STALE_LAST_MINUTES) {
    flags.push({
      code: "STALE_QUOTE",
      severity: "WARN",
      message: `Quote is ${Math.round(ageMinutes)} minutes old as of this run.`,
    });
  }

  return flags;
}

/** What a contract's premium is being measured from. */
export type EntryBasis = "ASK" | "MID" | "LAST" | "GIVEN";

/** Per-share premium plus how it was chosen, so a report never hides which price it used. */
export interface EntryPrice {
  readonly price: number;
  readonly basis: EntryBasis;
}

/**
 * Picks the premium to reason from.
 *
 * Prefers the ask, because a buyer pays the ask and the whole point of the
 * exercise is what an entry would actually cost. Falls back to the midpoint,
 * then to `last` — which is the least trustworthy of the three, since an
 * untraded contract reports a stale print or a literal zero.
 */
export function resolveEntryPrice(leg: ChainLeg, override?: number): EntryPrice {
  if (override !== undefined) return { price: override, basis: "GIVEN" };
  const { bid, ask, last } = leg.quote;
  if (ask !== undefined && ask > 0) return { price: ask, basis: "ASK" };
  if (bid !== undefined && ask !== undefined && bid + ask > 0) return { price: (bid + ask) / 2, basis: "MID" };
  return { price: last, basis: "LAST" };
}

/** Liquidity and data-quality flags derived from one leg's quote and Greeks. */
export function legQualityFlags(leg: ChainLeg): readonly AnalysisFlag[] {
  const flags: AnalysisFlag[] = [];
  const { bid, ask, openInterest, volume } = leg.quote;

  if (bid !== undefined && bid === 0) {
    flags.push({
      code: "ZERO_BID",
      severity: "BLOCK",
      message:
        "Strike has no bid: there is nothing to sell into, so the position could not be exited at any price " +
        "regardless of what the mid implies.",
    });
  }

  if (bid !== undefined && ask !== undefined && bid > 0 && ask > 0) {
    const mid = (bid + ask) / 2;
    const spreadRatio = (ask - bid) / mid;
    if (spreadRatio >= SEVERE_SPREAD_RATIO) {
      flags.push({
        code: "SEVERE_SPREAD",
        severity: "BLOCK",
        message:
          `Bid/ask spread is ${(spreadRatio * 100).toFixed(1)}% of mid ($${bid.toFixed(2)}/$${ask.toFixed(2)}). ` +
          "Entry and exit costs alone consume a large share of the premium; a round trip starts deeply negative.",
      });
    } else if (spreadRatio >= WIDE_SPREAD_RATIO) {
      flags.push({
        code: "WIDE_SPREAD",
        severity: "WARN",
        message: `Bid/ask spread is ${(spreadRatio * 100).toFixed(1)}% of mid, above the ${(
          WIDE_SPREAD_RATIO * 100
        ).toFixed(0)}% liquidity threshold.`,
      });
    }
  }

  if (openInterest !== undefined && openInterest === 0) {
    flags.push({
      code: "NO_OPEN_INTEREST",
      severity: "WARN",
      message: "Open interest is zero: no established market in this contract.",
    });
  }

  if (volume !== undefined && volume === 0) {
    flags.push({
      code: "NO_VOLUME",
      severity: "WARN",
      message: "No contracts traded today, so `last` carries no current information.",
    });
  }

  if (leg.greeks !== undefined && leg.greeks.impliedVolatility === 0 && Math.abs(leg.greeks.delta) >= 0.999) {
    flags.push({
      code: "IV_ARTIFACT",
      severity: "WARN",
      message:
        "Reported implied volatility is exactly 0 alongside a delta of ±1 — a deep-ITM pricing artifact, not a " +
        "real volatility reading. Excluded from IV comparisons.",
    });
  }

  if (leg.midPrice !== undefined && bid !== undefined && ask !== undefined && bid > 0 && ask > 0) {
    const computedMid = (bid + ask) / 2;
    if (Math.abs(computedMid - leg.midPrice) > 0.02) {
      flags.push({
        code: "MID_DISAGREEMENT",
        severity: "INFO",
        message: `Vendor mid ($${leg.midPrice.toFixed(2)}) differs from (bid+ask)/2 ($${computedMid.toFixed(2)}).`,
      });
    }
  }

  return flags;
}

/** True when a leg's IV can be compared against another's. */
export function hasUsableIv(leg: ChainLeg | undefined): boolean {
  if (leg?.greeks === undefined) return false;
  const { impliedVolatility, delta } = leg.greeks;
  return impliedVolatility > 0 && Math.abs(delta) < 0.999;
}

/** Everything a report needs about one contract, with the premium basis and flags attached. */
export interface ContractAnalysis {
  readonly contract: OptionContract;
  readonly underlyingPrice: number;
  /** Per-share premium the maths below uses. */
  readonly entryPrice: number;
  readonly entryBasis: EntryBasis;
  /** What one contract costs: `entryPrice` × 100. Never confuse the two. */
  readonly entryPricePerContract: number;
  /** Underlying price at which the position breaks even at expiration. */
  readonly breakeven: number;
  /** Move in the underlying required to reach breakeven, as a ratio. */
  readonly breakevenMoveRatio: number;
  /** Underlying price at which the premium doubles, valued at expiration. */
  readonly priceFor2x: number;
  readonly moveRatioFor2x: number;
  /** At expiration the contract is worthless on the wrong side of its strike. */
  readonly priceForWorthless: number;
  readonly moveRatioForWorthless: number;
  readonly delta?: number;
  /** Theta per contract per day: per-share theta × 100. */
  readonly thetaPerContractPerDay?: number;
  /** That daily decay as a share of the premium paid. */
  readonly thetaShareOfPremium?: number;
  readonly impliedVolatility?: number;
  readonly spread?: number;
  readonly spreadShareOfMid?: number;
  readonly flags: readonly AnalysisFlag[];
}

const CONTRACT_MULTIPLIER = 100;

/**
 * Runs the full per-contract analysis.
 *
 * `underlyingPrice` is passed in rather than read from the leg, because the
 * underlying and the option must be quoted from the same moment for any of
 * these figures to be coherent — the caller is responsible for pulling them
 * together, and `quoteFreshnessFlags` is what checks it.
 */
export function analyseContract(
  leg: ChainLeg,
  underlyingPrice: number,
  runAt: string,
  entryOverride?: number,
): ContractAnalysis {
  const { contract } = leg;
  const { price: entryPrice, basis: entryBasis } = resolveEntryPrice(leg, entryOverride);
  const strike = contract.strike;
  const isCall = contract.side === "CALL";

  // At expiration a call is worth max(0, S − K) and a put max(0, K − S), so
  // each target price below is exact rather than modelled.
  const breakeven = isCall ? strike + entryPrice : strike - entryPrice;
  const priceFor2x = isCall ? strike + 2 * entryPrice : strike - 2 * entryPrice;
  const priceForWorthless = strike;

  const moveRatio = (target: number): number =>
    underlyingPrice === 0 ? Number.NaN : roundTo(target / underlyingPrice - 1, 6);

  const flags = [
    ...quoteFreshnessFlags(leg.quote.timestamp, runAt),
    ...legQualityFlags(leg),
  ];

  const { bid, ask } = leg.quote;
  const spread = bid !== undefined && ask !== undefined ? roundTo(ask - bid, 4) : undefined;
  const mid = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : undefined;
  const spreadShareOfMid =
    spread !== undefined && mid !== undefined && mid > 0 ? roundTo(spread / mid, 6) : undefined;

  const greeks = leg.greeks;
  const thetaPerContractPerDay =
    greeks === undefined ? undefined : roundTo(greeks.theta * CONTRACT_MULTIPLIER, 4);
  const thetaShareOfPremium =
    thetaPerContractPerDay === undefined || entryPrice <= 0
      ? undefined
      : roundTo(Math.abs(thetaPerContractPerDay) / (entryPrice * CONTRACT_MULTIPLIER), 6);

  return {
    contract,
    underlyingPrice,
    entryPrice: roundTo(entryPrice, 4),
    entryBasis,
    entryPricePerContract: roundTo(entryPrice * CONTRACT_MULTIPLIER, 2),
    breakeven: roundTo(breakeven, 4),
    breakevenMoveRatio: moveRatio(breakeven),
    priceFor2x: roundTo(priceFor2x, 4),
    moveRatioFor2x: moveRatio(priceFor2x),
    priceForWorthless: roundTo(priceForWorthless, 4),
    moveRatioForWorthless: moveRatio(priceForWorthless),
    ...(greeks === undefined ? {} : { delta: greeks.delta }),
    ...(thetaPerContractPerDay === undefined ? {} : { thetaPerContractPerDay }),
    ...(thetaShareOfPremium === undefined ? {} : { thetaShareOfPremium }),
    ...(greeks === undefined || greeks.impliedVolatility === 0
      ? {}
      : { impliedVolatility: greeks.impliedVolatility }),
    ...(spread === undefined ? {} : { spread }),
    ...(spreadShareOfMid === undefined ? {} : { spreadShareOfMid }),
    flags,
  };
}

/** One strike's IV compared across two expirations. */
export interface IvTermComparison {
  readonly strike: number;
  readonly side: OptionSide;
  readonly nearIv: number;
  readonly farIv: number;
  /** Larger IV divided by smaller, so the ratio is always ≥ 1 and reads the same either way. */
  readonly ratio: number;
  readonly anomalous: boolean;
}

/** The result of comparing two chains: per-strike ratios plus flags for the anomalies. */
export interface IvTermCheck {
  readonly nearExpiration: string;
  readonly farExpiration: string;
  readonly comparisons: readonly IvTermComparison[];
  readonly flags: readonly AnalysisFlag[];
}

function legForSide(row: { readonly call?: ChainLeg; readonly put?: ChainLeg }, side: OptionSide): ChainLeg | undefined {
  return side === "CALL" ? row.call : row.put;
}

/**
 * Compares implied volatility at matching strikes across two expirations.
 *
 * A real term-structure move is gradual; a same-strike IV that differs by more
 * than ~2× between adjacent expirations is far more often a stale or
 * artifact-laden quote than a genuine signal, which is exactly the check that
 * would have caught the bad Greeks in an earlier manual run. Legs whose IV is
 * the deep-ITM `0` artifact are skipped rather than compared, since comparing
 * against zero would flag every one of them.
 */
export function checkIvTermStructure(
  near: ChainSnapshot,
  far: ChainSnapshot,
  sides: readonly OptionSide[] = ["CALL", "PUT"],
): IvTermCheck {
  const farByStrike = new Map(far.rows.map((row) => [row.strike, row]));
  const comparisons: IvTermComparison[] = [];

  for (const nearRow of near.rows) {
    const farRow = farByStrike.get(nearRow.strike);
    if (farRow === undefined) continue;

    for (const side of sides) {
      const nearLeg = legForSide(nearRow, side);
      const farLeg = legForSide(farRow, side);
      if (!hasUsableIv(nearLeg) || !hasUsableIv(farLeg)) continue;

      const nearIv = nearLeg?.greeks?.impliedVolatility ?? 0;
      const farIv = farLeg?.greeks?.impliedVolatility ?? 0;
      const ratio = roundTo(Math.max(nearIv, farIv) / Math.min(nearIv, farIv), 4);

      comparisons.push({
        strike: nearRow.strike,
        side,
        nearIv,
        farIv,
        ratio,
        anomalous: ratio > IV_TERM_ANOMALY_FACTOR,
      });
    }
  }

  const anomalies = comparisons.filter((comparison) => comparison.anomalous);
  const flags: AnalysisFlag[] =
    anomalies.length === 0
      ? []
      : [
          {
            code: "IV_TERM_ANOMALY",
            severity: "WARN",
            message:
              `${anomalies.length} strike(s) show implied volatility differing by more than ` +
              `${IV_TERM_ANOMALY_FACTOR}× between ${near.expiration} and ${far.expiration} ` +
              `(worst: $${anomalies[0]?.strike} ${anomalies[0]?.side.toLowerCase()} at ` +
              `${anomalies[0]?.ratio}×). That usually indicates a data artifact rather than a real ` +
              "term-structure move — verify before treating either expiration's IV as meaningful.",
          },
        ];

  return { nearExpiration: near.expiration, farExpiration: far.expiration, comparisons, flags };
}

/** Finds the strike closest to spot — the ATM default when no strike is specified. */
export function atmStrike(chain: ChainSnapshot, spot: number): number | undefined {
  let best: { strike: number; distance: number } | undefined;
  for (const row of chain.rows) {
    const distance = Math.abs(row.strike - spot);
    if (best === undefined || distance < best.distance) best = { strike: row.strike, distance };
  }
  return best?.strike;
}

/** Narrows a chain to strikes within `window` dollars of spot, keeping the report readable. */
export function strikesNearSpot(chain: ChainSnapshot, spot: number, window: number): ChainSnapshot {
  return {
    ...chain,
    rows: chain.rows.filter((row) => Math.abs(row.strike - spot) <= window),
  };
}

/** The most severe flag present, for sorting and for deciding whether to print a hard caveat. */
export function worstSeverity(flags: readonly AnalysisFlag[]): FlagSeverity | undefined {
  if (flags.some((flag) => flag.severity === "BLOCK")) return "BLOCK";
  if (flags.some((flag) => flag.severity === "WARN")) return "WARN";
  if (flags.some((flag) => flag.severity === "INFO")) return "INFO";
  return undefined;
}
