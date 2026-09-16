import type { Candidate, CatalystFlag } from "./types";

/**
 * Dated events that could move a name inside the window being checked.
 *
 * The per-ticker shape here is forced by the data available rather than chosen:
 * no connector in this project exposes a market-wide forward earnings calendar
 * (Twelve_Data's earnings endpoint takes one symbol and returns that symbol's
 * history; the calendar-wide endpoints are plan-gated). So a run looks up each
 * candidate individually, which is why `minPortfolioWeight` exists as a way to
 * bound the work when the position count grows.
 *
 * Like `candidates.ts`, this module is pure. The caller fetches; these
 * functions decide what counts as inside the window and how far away it is.
 * That keeps a report reproducible from a saved input, and keeps the trading-day
 * arithmetic — the part that is easy to get wrong — under test.
 */

/** How many trading days ahead a check-in looks for catalysts. */
export const DEFAULT_CATALYST_WINDOW_DAYS = 5;

/** A raw dated event, before the window filter decides whether it matters. */
export interface RawCatalyst {
  readonly symbol: string;
  readonly kind: CatalystFlag["kind"];
  /** YYYY-MM-DD. */
  readonly date: string;
  readonly detail: string;
}

/** True for Saturday and Sunday. Market holidays are supplied separately. */
function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function toUtcDate(isoDate: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (match === null) {
    throw new Error(`Expected a YYYY-MM-DD date, got ${JSON.stringify(isoDate)}`);
  }
  const [, year, month, day] = match as unknown as [string, string, string, string];
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Counts trading days from `from` to `to`, skipping weekends and any supplied
 * holidays. Same-day is 0; the next trading day is 1.
 *
 * Returns a negative count for a date in the past, so a caller can tell "this
 * already happened" from "this is today" — an earnings print from yesterday is
 * still context for today's price action, but it is not an upcoming catalyst.
 */
export function tradingDaysBetween(from: string, to: string, holidays: readonly string[] = []): number {
  const holidaySet = new Set(holidays);
  const start = toUtcDate(from);
  const end = toUtcDate(to);
  if (start.getTime() === end.getTime()) return 0;

  const backwards = end.getTime() < start.getTime();
  const [earlier, later] = backwards ? [end, start] : [start, end];

  let count = 0;
  const cursor = new Date(earlier.getTime());
  while (cursor.getTime() < later.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isWeekend(cursor) || holidaySet.has(formatUtcDate(cursor))) continue;
    count += 1;
  }

  return backwards ? -count : count;
}

/** Adds `tradingDays` trading days to a date, skipping weekends and holidays. */
export function addTradingDays(from: string, tradingDays: number, holidays: readonly string[] = []): string {
  const holidaySet = new Set(holidays);
  const cursor = toUtcDate(from);
  let remaining = tradingDays;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isWeekend(cursor) || holidaySet.has(formatUtcDate(cursor))) continue;
    remaining -= 1;
  }
  return formatUtcDate(cursor);
}

export interface CatalystWindowInput {
  /** The run's ET calendar date, YYYY-MM-DD. */
  readonly runDate: string;
  readonly events: readonly RawCatalyst[];
  readonly windowTradingDays?: number;
  readonly holidays?: readonly string[];
}

/**
 * Filters raw events down to the ones landing inside the window, annotated with
 * how many trading days away each is.
 *
 * Past events are dropped rather than reported as "-2 days away": a check-in
 * asks what is coming, and a stale earnings date presented alongside upcoming
 * ones invites reading it as a future event.
 */
export function catalystsInWindow(input: CatalystWindowInput): readonly CatalystFlag[] {
  const window = input.windowTradingDays ?? DEFAULT_CATALYST_WINDOW_DAYS;
  const holidays = input.holidays ?? [];

  return input.events
    .map((event) => ({
      event,
      tradingDaysAway: tradingDaysBetween(input.runDate, event.date, holidays),
    }))
    .filter(({ tradingDaysAway }) => tradingDaysAway >= 0 && tradingDaysAway <= window)
    .map(({ event, tradingDaysAway }) => ({
      symbol: event.symbol.trim().toUpperCase(),
      kind: event.kind,
      date: event.date,
      tradingDaysAway,
      detail: event.detail,
    }))
    .sort((a, b) => {
      if (a.tradingDaysAway !== b.tradingDaysAway) return a.tradingDaysAway - b.tradingDaysAway;
      return a.symbol.localeCompare(b.symbol);
    });
}

/**
 * Which candidates a run should look catalysts up for.
 *
 * Defaults to every candidate. A weight threshold only ever drops *holdings*
 * below that weight — a watchlist name or a scan hit has no portfolio weight to
 * compare, and dropping it for that reason would silently empty the watchlist.
 */
export function candidatesToCheck(
  candidates: readonly Candidate[],
  minPortfolioWeight = 0,
): readonly Candidate[] {
  if (minPortfolioWeight <= 0) return candidates;
  return candidates.filter((candidate) => {
    if (candidate.portfolioWeight === undefined) return true;
    if (candidate.sources.includes("WATCHLIST") || candidate.sources.includes("MARKET_SCAN")) return true;
    return candidate.portfolioWeight >= minPortfolioWeight;
  });
}

/** Groups catalysts by symbol for rendering, preserving the window ordering within each. */
export function groupCatalystsBySymbol(
  catalysts: readonly CatalystFlag[],
): ReadonlyMap<string, readonly CatalystFlag[]> {
  const grouped = new Map<string, CatalystFlag[]>();
  for (const catalyst of catalysts) {
    const existing = grouped.get(catalyst.symbol);
    if (existing === undefined) grouped.set(catalyst.symbol, [catalyst]);
    else existing.push(catalyst);
  }
  return grouped;
}

/**
 * Splits the macro events out of a catalyst list.
 *
 * Macro events (CPI, FOMC, jobs) are not attached to any one holding — they
 * move the whole book — so a report states them once at the top rather than
 * repeating them under every position.
 */
export function partitionMacro(catalysts: readonly CatalystFlag[]): {
  readonly macro: readonly CatalystFlag[];
  readonly perSymbol: readonly CatalystFlag[];
} {
  return {
    macro: catalysts.filter((catalyst) => catalyst.kind === "MACRO"),
    perSymbol: catalysts.filter((catalyst) => catalyst.kind !== "MACRO"),
  };
}
