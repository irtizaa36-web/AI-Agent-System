import { roundTo } from "../public-trading/decimal";
import type { Direction } from "./recommend";

/**
 * Tracking a third-party channel's stated calls, and scoring them against what
 * actually happened.
 *
 * This module exists because a request to "incorporate a YouTube channel's
 * videos into the skill" runs directly against the skill's own founding
 * decision: `.agents/skills/options-trading-eval/SKILL.md`'s "Method deviation"
 * section explicitly declined to weight anything by how often it is repeated in
 * retail options education, because popularity is not evidence and at least one
 * of the most-repeated claims in that space is directly contradicted by
 * peer-reviewed evidence. Adding a channel's opinions as skill content would
 * reverse that decision by the back door.
 *
 * What this module does instead: record what a named source actually said,
 * before the outcome is known, and grade it afterward. That produces a real,
 * checkable hit rate over time — which is either evidence (if the rate turns
 * out to beat a coin flip, consistently, on enough calls) or a debunking (if it
 * doesn't) — rather than a channel's own claims imported as though they already
 * were one or the other.
 *
 * Three rules keep the grading honest:
 *
 * 1. **The call is recorded before the outcome, never adjusted after.** A
 *    signal's `recordedAt` and the market's `asOf` must be in that order; this
 *    module does not accept a call logged after the fact, because that is not
 *    tracking a prediction, it is transcribing a result.
 * 2. **Direction is graded, never conviction, framing, or a channel's own
 *    "trap" narrative.** "Trap" language is a classic unfalsifiable device —
 *    whichever way the market moves can be described as the trap springing.
 *    Grading reduces every call to the one thing that can actually be checked:
 *    did the underlying move where they said it would.
 * 3. **A NEUTRAL call is recorded but excluded from the hit rate.** There is no
 *    principled threshold for "the market went nowhere," and picking one would
 *    let the grading be tuned after the fact.
 */

/** One dated, stated call from a named source, recorded before the outcome is known. */
export interface ExternalSignal {
  /** Human name, e.g. "SPY Day Trading". Not a claim of credibility — just an identity to aggregate by. */
  readonly sourceName: string;
  readonly sourceUrl?: string;
  readonly videoUrl: string;
  readonly videoTitle?: string;
  /** When this was recorded, ISO timestamp. Must precede any outcome's `asOf`. */
  readonly recordedAt: string;
  /** The date the call is about, YYYY-MM-DD, if stated. Distinct from `recordedAt`: a video can call out a future date. */
  readonly forDate?: string;
  readonly symbol: string;
  readonly direction: Direction;
  /**
   * What was actually said, in the source's own words or a faithful summary.
   * Required and must be non-empty for the same reason a recommendation's
   * `mechanism` is required in `recommend.ts`: a graded call with no record of
   * what was claimed cannot be audited later, and "I watched it once and this
   * is my paraphrase" is exactly the kind of unverifiable claim this project
   * refuses to launder into something citable.
   */
  readonly statedThesis: string;
  readonly statedLevels?: {
    readonly support?: number;
    readonly resistance?: number;
    readonly target?: number;
    readonly stop?: number;
  };
}

/** What actually happened, measured at an explicit reference moment. */
export interface ExternalSignalOutcome {
  readonly videoUrl: string;
  readonly symbol: string;
  readonly recordedAt: string;
  readonly asOf: string;
  readonly referenceLabel: string;
  readonly priceAtCall?: number;
  readonly priceAtReference: number;
}

export type GradeResult = "HIT" | "MISS" | "UNGRADED";

export interface GradedSignal {
  readonly signal: ExternalSignal;
  readonly outcome?: ExternalSignalOutcome;
  readonly actualMoveRatio?: number;
  readonly grade: GradeResult;
  readonly reason: string;
}

/** Validates a signal is fit to record. Throws rather than silently accepting a hole in the record. */
export function validateExternalSignal(signal: ExternalSignal): void {
  if (signal.statedThesis.trim() === "") {
    throw new Error(
      `External signal for ${signal.symbol} (${signal.videoUrl}) has no stated thesis. A call with no record ` +
        "of what was actually claimed cannot be audited later — quote it or summarise it faithfully.",
    );
  }
  if (signal.sourceName.trim() === "") {
    throw new Error("External signal needs a sourceName to aggregate a hit rate by.");
  }
  if (signal.videoUrl.trim() === "") {
    throw new Error("External signal needs a videoUrl — the thing being graded must be identifiable.");
  }
}

/**
 * Grades one signal against its outcome.
 *
 * `UNGRADED` covers three cases, distinguished in `reason` rather than
 * collapsed into one: no outcome recorded yet, no `priceAtCall` to measure a
 * move from, and a `NEUTRAL` call, which this module refuses to grade at all
 * (see the module doc). A `HIT`/`MISS` requires none of those.
 */
export function gradeExternalSignal(signal: ExternalSignal, outcome: ExternalSignalOutcome | undefined): GradedSignal {
  if (outcome === undefined) {
    return { signal, grade: "UNGRADED", reason: "No outcome recorded yet." };
  }
  if (new Date(outcome.asOf).getTime() < new Date(signal.recordedAt).getTime()) {
    throw new Error(
      `Outcome for ${signal.videoUrl} is timestamped before the signal was recorded (${outcome.asOf} < ` +
        `${signal.recordedAt}). A call graded against an earlier moment is not a prediction being checked.`,
    );
  }
  if (signal.direction === "NEUTRAL") {
    return { signal, outcome, grade: "UNGRADED", reason: "NEUTRAL calls are recorded but never graded — see module doc." };
  }
  if (outcome.priceAtCall === undefined || outcome.priceAtCall === 0) {
    return { signal, outcome, grade: "UNGRADED", reason: "No priceAtCall recorded, so no move can be measured." };
  }

  const actualMoveRatio = roundTo(outcome.priceAtReference / outcome.priceAtCall - 1, 6);
  const hit =
    (signal.direction === "BULLISH" && actualMoveRatio > 0) ||
    (signal.direction === "BEARISH" && actualMoveRatio < 0);

  return {
    signal,
    outcome,
    actualMoveRatio,
    grade: hit ? "HIT" : "MISS",
    reason: `${signal.symbol} moved ${(actualMoveRatio * 100).toFixed(2)}% against a ${signal.direction} call.`,
  };
}

/** Pairs each signal with its outcome (by videoUrl + symbol) and grades it. */
export function gradeAllSignals(
  signals: readonly ExternalSignal[],
  outcomes: readonly ExternalSignalOutcome[],
): readonly GradedSignal[] {
  const byKey = new Map<string, ExternalSignalOutcome>();
  for (const outcome of outcomes) byKey.set(`${outcome.videoUrl}::${outcome.symbol}`, outcome);
  return signals.map((signal) => gradeExternalSignal(signal, byKey.get(`${signal.videoUrl}::${signal.symbol}`)));
}

export interface SourceStats {
  readonly sourceName: string;
  readonly totalCalls: number;
  readonly graded: number;
  readonly hits: number;
  readonly misses: number;
  readonly ungraded: number;
  /** Undefined rather than 0/0 when nothing is graded yet — an unrated source is not the same as a 0% one. */
  readonly hitRate?: number;
}

/** Aggregates graded signals into a hit rate per source. Never mixes sources into one number. */
export function summariseBySource(graded: readonly GradedSignal[]): readonly SourceStats[] {
  const bySource = new Map<string, GradedSignal[]>();
  for (const entry of graded) {
    const list = bySource.get(entry.signal.sourceName);
    if (list === undefined) bySource.set(entry.signal.sourceName, [entry]);
    else list.push(entry);
  }

  return [...bySource.entries()]
    .map(([sourceName, entries]) => {
      const hits = entries.filter((entry) => entry.grade === "HIT").length;
      const misses = entries.filter((entry) => entry.grade === "MISS").length;
      const ungraded = entries.filter((entry) => entry.grade === "UNGRADED").length;
      const gradedCount = hits + misses;
      return {
        sourceName,
        totalCalls: entries.length,
        graded: gradedCount,
        hits,
        misses,
        ungraded,
        ...(gradedCount === 0 ? {} : { hitRate: roundTo(hits / gradedCount, 4) }),
      };
    })
    .sort((a, b) => a.sourceName.localeCompare(b.sourceName));
}
