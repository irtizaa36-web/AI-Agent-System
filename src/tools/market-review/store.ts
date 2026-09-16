import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "../../store/run-store";
import { renderMarketReview } from "./render";
import type { MarketReview, PriorRunReference } from "./review";
import { priorReferenceFrom } from "./review";
import type { CheckInSlot } from "./types";

/**
 * Where check-ins and the prediction log live.
 *
 * Two different artefacts, on purpose:
 *
 * - **Reports** are Markdown, one file per run, under
 *   `docs/operations/market-review/`. They are for reading, and they are the
 *   record of what was known at 09:00 versus 15:30 on a given day.
 * - **The prediction log** is one append-only JSONL file. It is for counting —
 *   accuracy over weeks — and that is a tabular question, not a narrative one.
 *   Append-only matters: a run may add a row and a later run may add its
 *   outcome, but nothing rewrites history, so the log cannot be quietly
 *   improved after the fact.
 *
 * The same visibility note as the sibling system applies: these files record
 * account value, positions and suggested sizes, and this repository is public.
 * That was a deliberate choice for durability across sessions and clients. If
 * the repository's visibility assumptions change, these directories are the
 * first thing to revisit.
 */
export const DEFAULT_REVIEW_DIR = "docs/operations/market-review";

export const DEFAULT_LOG_PATH = "docs/operations/market-review/prediction-log.jsonl";

/** `YYYY-MM-DD-<slot>.md`, with a numeric suffix if the same slot runs twice in a day. */
export function reviewFileName(
  etDate: string,
  slot: CheckInSlot,
  existing: readonly string[] = [],
): string {
  const base = `${etDate}-${slot}.md`;
  if (!existing.includes(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${etDate}-${slot}-${suffix}.md`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${etDate}-${slot}-${Date.now()}.md`;
}

const REVIEW_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})-(pre-open|opening|midday|pre-close)(-\d+)?\.md$/;

async function listReviewFiles(dir: string): Promise<readonly string[]> {
  try {
    const files = await readdir(dir);
    return files.filter((file) => REVIEW_FILE_PATTERN.test(file)).sort();
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
}

/** Pulls one quoted frontmatter string out of a rendered report. */
function frontmatterValue(markdown: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, "m").exec(markdown.slice(0, 2000));
  return match?.[1];
}

/**
 * Reads enough of the newest previous report to serve as this run's prior
 * reference.
 *
 * The underlying prices live in the report's "Change since" and contract
 * sections as prose, which would be fragile to parse, so the prior reference is
 * instead read from the prediction log — which stores them as data for exactly
 * this purpose. This function handles the report-side half: which run was last,
 * and when.
 */
export async function readLatestRunStamp(
  dir: string = DEFAULT_REVIEW_DIR,
): Promise<{ runAt: string; slot: CheckInSlot } | undefined> {
  const files = await listReviewFiles(dir);
  for (const file of [...files].reverse()) {
    const markdown = await readFile(join(dir, file), "utf-8");
    const runAt = frontmatterValue(markdown, "runAt");
    const slot = frontmatterValue(markdown, "slot");
    if (runAt !== undefined && slot !== undefined) {
      return { runAt, slot: slot as CheckInSlot };
    }
  }
  return undefined;
}

export interface WrittenReview {
  readonly path: string;
  readonly markdown: string;
}

/** Renders and writes one check-in report. */
export async function writeMarketReview(
  review: MarketReview,
  dir: string = DEFAULT_REVIEW_DIR,
): Promise<WrittenReview> {
  await mkdir(dir, { recursive: true });
  const existing = await listReviewFiles(dir);
  const path = join(dir, reviewFileName(review.clock.etDate, review.slot, existing));
  const markdown = renderMarketReview(review);
  await writeFile(path, markdown, "utf-8");
  return { path, markdown };
}

/**
 * One row in the prediction log.
 *
 * `theoreticalEntry` is explicitly named: no order was placed, so this is the
 * premium the analysis used, not a fill. `outcome` is filled in by a later
 * close-the-loop run rather than guessed at write time — a row with no outcome
 * is an open prediction, and that distinction is the entire point of the log.
 */
export interface PredictionLogEntry {
  readonly runAt: string;
  readonly etDate: string;
  readonly slot: CheckInSlot;
  readonly symbol: string;
  readonly direction: string;
  readonly conviction: string;
  readonly contractLabel?: string;
  readonly osiSymbol?: string;
  /** Per-contract premium the analysis used. Not a fill. */
  readonly theoreticalEntry?: number;
  readonly suggestedContracts?: number;
  readonly underlyingPrice?: number;
  readonly breakeven?: number;
  readonly score: number;
  readonly blocked: boolean;
  readonly mechanism: string;
  /** Prices this run saw, so the next run can compute its deltas from data, not prose. */
  readonly underlyingPrices?: Readonly<Record<string, number>>;
  readonly vix?: number;
}

/** A close-the-loop row: what actually happened, measured at an explicit reference time. */
export interface OutcomeLogEntry {
  readonly kind: "OUTCOME";
  readonly recordedAt: string;
  /** The run this outcome closes the loop on. */
  readonly forRunAt: string;
  readonly symbol: string;
  readonly osiSymbol?: string;
  /**
   * The reference moment the mark was taken at — chosen by the operator per run
   * rather than assumed to be the 16:00 close, because 0DTE maths changes by the
   * minute and "at the close" is not the only question worth asking.
   */
  readonly asOf: string;
  readonly referenceLabel: string;
  readonly underlyingPrice?: number;
  readonly optionMark?: number;
  readonly theoreticalEntry?: number;
  /** Per-contract P/L against `theoreticalEntry`, when both are known. */
  readonly theoreticalPlPerContract?: number;
  readonly note?: string;
}

export type LogEntry = ({ readonly kind: "PREDICTION" } & PredictionLogEntry) | OutcomeLogEntry;

/** Appends rows to the prediction log, creating it if this is the first run. */
export async function appendLogEntries(
  entries: readonly LogEntry[],
  logPath: string = DEFAULT_LOG_PATH,
): Promise<number> {
  if (entries.length === 0) return 0;
  await mkdir(join(logPath, ".."), { recursive: true });
  const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await appendFile(logPath, `${body}\n`, "utf-8");
  return entries.length;
}

/** Reads every log row. Returns an empty list when the log does not exist yet. */
export async function readLogEntries(logPath: string = DEFAULT_LOG_PATH): Promise<readonly LogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(logPath, "utf-8");
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }

  const entries: LogEntry[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      entries.push(JSON.parse(trimmed) as LogEntry);
    } catch {
      // A corrupt line is reported rather than silently skipped: a log whose
      // rows can vanish without notice cannot answer "how accurate was I".
      throw new Error(`Prediction log line ${index + 1} is not valid JSON: ${trimmed.slice(0, 120)}`);
    }
  }
  return entries;
}

/**
 * Builds the prior reference for this run from the newest prediction row that
 * carried prices. Reading it from the log rather than parsing a rendered report
 * keeps the continuity path on data instead of prose.
 */
export async function readPriorReference(
  logPath: string = DEFAULT_LOG_PATH,
): Promise<PriorRunReference | undefined> {
  const entries = await readLogEntries(logPath);
  for (const entry of [...entries].reverse()) {
    if (entry.kind !== "PREDICTION") continue;
    if (entry.underlyingPrices === undefined) continue;
    return {
      runAt: entry.runAt,
      slot: entry.slot,
      underlyingPrices: entry.underlyingPrices,
    };
  }
  return undefined;
}

/**
 * Turns a review into its log rows.
 *
 * A run with no recommendations still logs one row carrying the prices it saw,
 * so the next check-in can compute its deltas and so a quiet run is
 * distinguishable from a run that never happened.
 */
export function logEntriesFor(review: MarketReview): readonly LogEntry[] {
  const reference = priorReferenceFrom(review);
  const shared = {
    runAt: review.runAt,
    etDate: review.clock.etDate,
    slot: review.slot,
    underlyingPrices: reference.underlyingPrices,
    ...(review.vix === undefined ? {} : { vix: review.vix.last }),
  };

  if (review.recommendations.length === 0) {
    return [
      {
        kind: "PREDICTION",
        ...shared,
        symbol: "—",
        direction: "NONE",
        conviction: "NONE",
        score: 0,
        blocked: review.incomplete !== undefined,
        mechanism:
          review.incomplete === undefined
            ? "No candidate reached a stated thesis this run."
            : `Run did not complete: ${review.incomplete.reason}`,
      },
    ];
  }

  return review.recommendations.map((recommendation): LogEntry => {
    // Match on the contract's OSI symbol, never on its underlying: a run that
    // analysed both a SPY call and a SPY put has two analyses sharing an
    // underlying, and picking the first one attaches the wrong strike, side and
    // breakeven to the row. Only fall back to the underlying when the
    // recommendation carries no contract at all (a stock-level idea).
    const analysis =
      recommendation.osiSymbol === undefined
        ? review.contractAnalyses.find((candidate) => candidate.contract.underlying === recommendation.symbol)
        : review.contractAnalyses.find(
            (candidate) => candidate.contract.osiSymbol === recommendation.osiSymbol,
          );
    return {
      kind: "PREDICTION",
      ...shared,
      symbol: recommendation.symbol,
      direction: recommendation.direction,
      conviction: recommendation.conviction,
      ...(recommendation.contractLabel === undefined ? {} : { contractLabel: recommendation.contractLabel }),
      ...(analysis === undefined ? {} : { osiSymbol: analysis.contract.osiSymbol }),
      ...(recommendation.premiumPerContract === undefined
        ? {}
        : { theoreticalEntry: recommendation.premiumPerContract }),
      ...(recommendation.contracts === undefined ? {} : { suggestedContracts: recommendation.contracts }),
      ...(analysis === undefined ? {} : { underlyingPrice: analysis.underlyingPrice, breakeven: analysis.breakeven }),
      score: recommendation.score,
      blocked: recommendation.blocked,
      mechanism: recommendation.mechanism,
    };
  });
}
