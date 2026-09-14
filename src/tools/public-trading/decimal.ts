/**
 * The Public API returns every monetary and quantity value as a decimal
 * *string* — `"14.91"`, `"45.15599343"`, `"-36.999993552"` — never a JSON
 * number. Parsing is centralised here so a malformed field fails loudly at
 * the boundary with the field name attached, rather than silently becoming
 * `NaN` and propagating into a review file as "$NaN".
 *
 * Values are parsed to `number`. This is a monitoring and reporting tool on
 * an account measured in hundreds of dollars, not a ledger of record: double
 * precision is far more than enough to report P/L to the cent, and the
 * alternative (a decimal library) would breach ADR 0002's zero-runtime-
 * dependency rule for no practical gain. Round with `roundTo` before
 * displaying so accumulated float error never surfaces as `0.30000000000000004`.
 */

/** Parses a required decimal string. Throws with the field name if absent or unparseable. */
export function parseDecimal(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Expected decimal string for "${field}", got ${JSON.stringify(value)}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Could not parse "${field}" as a decimal: ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** Parses an optional decimal string, falling back when the field is absent or empty. */
export function parseOptionalDecimal(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  try {
    return parseDecimal(value, "optional");
  } catch {
    return fallback;
  }
}

/** Rounds to `places` decimals, correcting the usual binary-float edge (e.g. 1.005 -> 1.01). */
export function roundTo(value: number, places: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON * Math.sign(value) * Math.abs(value)) * factor) / factor;
}

/** Formats a dollar amount for a review file, always signed for P/L columns when `signed`. */
export function formatUsd(value: number, signed = false): string {
  if (!Number.isFinite(value)) return "n/a";
  const rounded = roundTo(value, 2);
  const sign = signed && rounded > 0 ? "+" : rounded < 0 ? "-" : "";
  return `${sign}$${Math.abs(rounded).toFixed(2)}`;
}

/** Formats a ratio (0.0075) as a percentage string ("0.75%"). */
export function formatPercent(ratio: number, places = 2, signed = false): string {
  if (!Number.isFinite(ratio)) return "n/a";
  const pct = roundTo(ratio * 100, places);
  const sign = signed && pct > 0 ? "+" : pct < 0 ? "-" : "";
  return `${sign}${Math.abs(pct).toFixed(places)}%`;
}
