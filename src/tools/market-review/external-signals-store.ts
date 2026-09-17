import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "../../store/run-store";
import type { ExternalSignal, ExternalSignalOutcome } from "./external-signals";

/**
 * Where tracked third-party calls live: a file of their own, never appended to
 * `store.ts`'s prediction log. Keeping them apart means a reader scanning
 * `prediction-log.jsonl` never has to wonder, row by row, whether an entry is
 * this system's own recommendation or a YouTube channel's — the two logs
 * answer different questions and a merge would blur exactly the line this
 * module exists to hold.
 */
export const DEFAULT_EXTERNAL_SIGNAL_LOG_PATH = "docs/operations/market-review/external-signals.jsonl";

export type ExternalSignalLogEntry =
  | ({ readonly kind: "SIGNAL" } & ExternalSignal)
  | ({ readonly kind: "OUTCOME" } & ExternalSignalOutcome);

/** Appends rows, creating the file on first use. Never rewrites an earlier row. */
export async function appendExternalSignalEntries(
  entries: readonly ExternalSignalLogEntry[],
  logPath: string = DEFAULT_EXTERNAL_SIGNAL_LOG_PATH,
): Promise<number> {
  if (entries.length === 0) return 0;
  await mkdir(join(logPath, ".."), { recursive: true });
  const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await appendFile(logPath, `${body}\n`, "utf-8");
  return entries.length;
}

/** Reads every row. An absent file reads as no rows yet, not an error. */
export async function readExternalSignalEntries(
  logPath: string = DEFAULT_EXTERNAL_SIGNAL_LOG_PATH,
): Promise<readonly ExternalSignalLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(logPath, "utf-8");
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }

  const entries: ExternalSignalLogEntry[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      entries.push(JSON.parse(trimmed) as ExternalSignalLogEntry);
    } catch {
      throw new Error(`External signal log line ${index + 1} is not valid JSON: ${trimmed.slice(0, 120)}`);
    }
  }
  return entries;
}

/** Splits the log into its two row kinds, for feeding `gradeAllSignals`. */
export function splitExternalSignalLog(entries: readonly ExternalSignalLogEntry[]): {
  readonly signals: readonly ExternalSignal[];
  readonly outcomes: readonly ExternalSignalOutcome[];
} {
  const signals: ExternalSignal[] = [];
  const outcomes: ExternalSignalOutcome[] = [];
  for (const entry of entries) {
    if (entry.kind === "SIGNAL") {
      const { kind, ...signal } = entry;
      signals.push(signal);
    } else {
      const { kind, ...outcome } = entry;
      outcomes.push(outcome);
    }
  }
  return { signals, outcomes };
}
