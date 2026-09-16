import type { OptionContract, OptionSide } from "./types";

/**
 * OSI option symbols, parsed and built.
 *
 * The Public API identifies every contract by its OSI symbol and accepts
 * nothing else — `get_option_greeks` takes `osi_symbols`, not a
 * ticker/strike/expiry triple — so building these correctly is load-bearing
 * rather than cosmetic. An off-by-one in the strike's implied decimal point
 * silently asks for a different contract that usually also exists, which is
 * the worst possible failure mode: a plausible answer about the wrong option.
 *
 * Layout, from the right: the last 15 characters are always
 * `YYMMDD` + `C`|`P` + an 8-digit strike in thousandths. Everything before
 * that is the root symbol, which varies in length (SPY, IOVA, GOOGL), so the
 * parse anchors on the right and never assumes a padded 6-character root.
 *
 *   IOVA 261016 C 00012500  ->  IOVA, 2026-10-16, call, $12.50
 *   SPY  260916 P 00660000  ->  SPY,  2026-09-16, put,  $660.00
 */

/** Characters after the root: 6 date + 1 side + 8 strike. */
const SUFFIX_LENGTH = 15;

/** The strike is encoded in thousandths of a dollar: 00012500 is $12.50. */
const STRIKE_SCALE = 1000;

const OSI_PATTERN = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/;

/** Parses an OSI symbol. Throws rather than guessing, since a wrong guess names a real but different contract. */
export function parseOsiSymbol(osiSymbol: string): OptionContract {
  const normalised = osiSymbol.trim().toUpperCase();
  const match = OSI_PATTERN.exec(normalised);
  if (match === null) {
    throw new Error(`Not an OSI option symbol: ${JSON.stringify(osiSymbol)}`);
  }
  const [, root, yymmdd, sideCode, strikeDigits] = match as unknown as [string, string, string, string, string];

  const year = 2000 + Number(yymmdd.slice(0, 2));
  const month = yymmdd.slice(2, 4);
  const day = yymmdd.slice(4, 6);

  return {
    osiSymbol: normalised,
    underlying: root,
    side: sideCode === "C" ? "CALL" : "PUT",
    strike: Number(strikeDigits) / STRIKE_SCALE,
    expiration: `${year}-${month}-${day}`,
  };
}

/** True when a string looks like an OSI option symbol rather than a plain ticker. */
export function isOsiSymbol(value: string): boolean {
  return OSI_PATTERN.test(value.trim().toUpperCase());
}

/** Builds an OSI symbol from its parts. `expiration` is YYYY-MM-DD. */
export function buildOsiSymbol(
  underlying: string,
  expiration: string,
  side: OptionSide,
  strike: number,
): string {
  const root = underlying.trim().toUpperCase();
  if (!/^[A-Z]{1,6}$/.test(root)) {
    throw new Error(`Not a usable option root symbol: ${JSON.stringify(underlying)}`);
  }
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiration.trim());
  if (dateMatch === null) {
    throw new Error(`Expiration must be YYYY-MM-DD, got ${JSON.stringify(expiration)}`);
  }
  const [, year, month, day] = dateMatch as unknown as [string, string, string, string];
  if (!Number.isFinite(strike) || strike <= 0) {
    throw new Error(`Strike must be a positive number, got ${JSON.stringify(strike)}`);
  }

  // Round before padding: 12.5 * 1000 is exactly 12500, but 0.07 * 1000 is
  // 70.00000000000001 in binary float, which would truncate to 00000070 —
  // the right answer by luck, and the wrong one at other strikes.
  const strikeDigits = String(Math.round(strike * STRIKE_SCALE)).padStart(8, "0");
  if (strikeDigits.length > 8) {
    throw new Error(`Strike ${strike} does not fit the 8-digit OSI field`);
  }

  return `${root}${year.slice(2)}${month}${day}${side === "CALL" ? "C" : "P"}${strikeDigits}`;
}

/** Human-readable contract label for a report line: "SPY $660 call exp 2026-09-16". */
export function describeContract(contract: OptionContract): string {
  const strike = Number.isInteger(contract.strike) ? String(contract.strike) : contract.strike.toFixed(2);
  return `${contract.underlying} $${strike} ${contract.side.toLowerCase()} exp ${contract.expiration}`;
}

/** Splits an OSI symbol's root off without a full parse. Returns undefined for a plain ticker. */
export function osiRoot(value: string): string | undefined {
  const normalised = value.trim().toUpperCase();
  if (!isOsiSymbol(normalised)) return undefined;
  return normalised.slice(0, normalised.length - SUFFIX_LENGTH);
}
