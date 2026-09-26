/**
 * Resilient parsing of CLI and model output (Karen upgrade 8).
 *
 * The sweep/monitor reads JSON from facebook-cli, hatch_messenger_cli, the
 * Gmail triage CLI, AgentMail, the cheap-tier summarizer, and the model-
 * written intake sidecar. Before this module a bad payload was swallowed
 * silently (safeParseEvents / parseComps / parseMyListingIds returned []
 * with no trace) or thrown up through the sweep. Now:
 *   - parseJsonLenient() tolerates the common model/CLI noise — code
 *     fences, log lines before or after the JSON — before giving up;
 *   - every failure emits ONE structured log record with the source, the
 *     error, and a truncated excerpt of the raw output, so failures can be
 *     audited after the fact;
 *   - callers degrade to an empty result instead of throwing, so one bad
 *     payload never crashes a run.
 * Log records go to stderr (local only). Raw excerpts can hold buyer text,
 * so they are capped and never written to state or the repo.
 */

export interface ParseFailure {
  readonly event: "marketplace.parse_failure";
  readonly at: string;
  /** Which producer, e.g. "messenger.threads", "comps.search", "intake.sidecar". */
  readonly source: string;
  readonly error: string;
  readonly rawLength: number;
  /** First RAW_EXCERPT_CHARS characters of the raw output. */
  readonly rawExcerpt: string;
}

export const RAW_EXCERPT_CHARS = 500;

export type ParseFailureSink = (failure: ParseFailure) => void;

const stderrSink: ParseFailureSink = (failure) => {
  process.stderr.write(`${JSON.stringify(failure)}\n`);
};

let sink: ParseFailureSink = stderrSink;

/** Swap the sink (tests, or the sweep collecting a run's failures). Returns a restore function. */
export function setParseFailureSink(next: ParseFailureSink): () => void {
  const prev = sink;
  sink = next;
  return () => {
    sink = prev;
  };
}

/** Record one parse failure with its raw output. Never throws. */
export function logParseFailure(source: string, error: unknown, raw: unknown): void {
  const text = typeof raw === "string" ? raw : safeStringify(raw);
  const failure: ParseFailure = {
    event: "marketplace.parse_failure",
    at: new Date().toISOString(),
    source,
    error: error instanceof Error ? error.message : String(error),
    rawLength: text.length,
    rawExcerpt: text.slice(0, RAW_EXCERPT_CHARS),
  };
  try {
    sink(failure);
  } catch {
    /* a broken sink must never take the run down */
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export type LenientResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/**
 * Parse JSON from CLI/model output. Tries, in order: the whole text, the
 * text inside a ```json fence, and the span from the first { or [ to the
 * last matching } or ]. Logs and returns ok:false when all fail.
 */
export function parseJsonLenient(raw: unknown, source: string): LenientResult {
  if (typeof raw !== "string") {
    logParseFailure(source, `expected a string, got ${raw === null ? "null" : typeof raw}`, raw);
    return { ok: false, error: "not a string" };
  }
  const text = raw.trim();
  if (text === "") {
    logParseFailure(source, "empty output", raw);
    return { ok: false, error: "empty output" };
  }
  const candidates = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  // Bracketed spans, the one that opens first tried first (an array of objects must not parse as its first object).
  const spans = ([["{", "}"], ["[", "]"]] as const)
    .map(([open, close]) => ({ start: text.indexOf(open), end: text.lastIndexOf(close) }))
    .filter((x) => x.start >= 0 && x.end > x.start)
    .sort((a, b) => a.start - b.start);
  for (const { start, end } of spans) candidates.push(text.slice(start, end + 1));
  let firstError = "";
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (error) {
      firstError ||= (error as Error).message;
    }
  }
  logParseFailure(source, firstError, raw);
  return { ok: false, error: firstError };
}

/** The item array from a CLI payload: a bare array, or data/messages/items under an object. */
export function itemsOf(value: unknown, source: string, raw: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["data", "messages", "items", "results"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  logParseFailure(source, "payload has no item array", raw);
  return [];
}
