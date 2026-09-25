import type { IsoDate } from "./types";

/**
 * Calendar-date helpers. Deadlines are dates, not instants: "days left" is
 * counted in whole calendar days in the owner's timezone, so a deadline never
 * flips a day early because of UTC.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The owner lives in Texas; override with SETTLEMENTS_TIMEZONE. */
export const DEFAULT_TIMEZONE = "America/Chicago";

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

function toUtcMs(date: IsoDate): number {
  if (!isIsoDate(date)) throw new Error(`Not a valid date (YYYY-MM-DD): ${date}`);
  return Date.parse(`${date}T00:00:00Z`);
}

/** Whole days from `today` to `date`: 0 on the day, negative once it has passed. */
export function daysUntil(date: IsoDate, today: IsoDate): number {
  return Math.round((toUtcMs(date) - toUtcMs(today)) / DAY_MS);
}

export function todayIn(timeZone: string = DEFAULT_TIMEZONE, now: Date = new Date()): IsoDate {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** A clock for the owner's timezone (SETTLEMENTS_TIMEZONE, default America/Chicago). */
export function ownerClock(): () => IsoDate {
  const timeZone = process.env["SETTLEMENTS_TIMEZONE"] || DEFAULT_TIMEZONE;
  return () => todayIn(timeZone);
}

/** "10/20/2026" or "10/20/26" (US month-first, as settlement sites print them) → "2026-10-20". */
export function parseUsDate(text: string): IsoDate | undefined {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(text);
  if (!m) return undefined;
  const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  const iso = `${year}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : undefined;
}

export function earliest(dates: readonly IsoDate[]): IsoDate | undefined {
  return [...dates].sort()[0];
}
