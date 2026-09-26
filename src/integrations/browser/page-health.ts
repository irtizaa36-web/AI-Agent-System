import type { BrowserClient, PageSnapshot } from "./client";

/**
 * Blocked-vs-quiet page classification, generalized from the X search sweep
 * (ADR 0025, ADR 0026). The one rule every caller relies on: a page that
 * didn't visibly load real content is `blocked`, never quiet. Only a page
 * that rendered real chrome AND explicitly says it has no results is
 * `empty`.
 *
 * - `ok`: real content loaded.
 * - `empty`: real chrome loaded and the page itself says there are zero results.
 * - `blocked`: blank, crashed, error shell, HTTP error, or a login/challenge redirect.
 * - `error`: the load itself threw (navigation failure, timeout, missing session).
 */
export type PageStatus = "ok" | "empty" | "blocked" | "error";

export interface ClassifyOptions {
  /** Rendered text shorter than this is a blank/blocked page. Matches the X sweep's original threshold. */
  readonly minTextLength?: number;
  /** Phrases that mark an error shell (e.g. "Something went wrong. Try reloading."). Only checked on pages shorter than `shellMaxLength`, so a long real page that merely mentions one of them stays `ok`. */
  readonly blockedMarkers?: readonly RegExp[];
  readonly shellMaxLength?: number;
  /** Phrases a page uses to say it has zero results. A page is only ever `empty` when one matches. */
  readonly emptyMarkers?: readonly RegExp[];
  /** The URL that was requested, so a redirect to a login/challenge page can be recognized from `finalUrl`. */
  readonly requestedUrl?: string;
}

export const DEFAULT_MIN_TEXT_LENGTH = 200;
export const DEFAULT_PACE_MS = 4000;
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 3;
const DEFAULT_SHELL_MAX_LENGTH = 1500;

export const DEFAULT_BLOCKED_MARKERS: readonly RegExp[] = [
  /something went wrong/i,
  /try reloading/i,
  /aw,? snap/i,
  /this (site|page) can.t be reached/i,
  /\bERR_[A-Z_]+\b/,
  /access denied/i,
  /too many requests/i,
  /rate limit(ed)?/i,
  /verify you are (a )?human/i,
  /are you a robot/i,
  /captcha/i,
  /temporarily (blocked|unavailable|restricted)/i,
];

export const DEFAULT_EMPTY_MARKERS: readonly RegExp[] = [
  /\bno (results|matches|jobs|listings|postings) (were )?found\b/i,
  /\bno jobs match\b/i,
  /\b0 (results|jobs|matches)\b/i,
  /\bwe couldn.t find any\b/i,
  /\bno results for\b/i,
];

const CHALLENGE_URL_PATTERN = /\/(login|log-in|signin|sign-in|i\/flow\/login|checkpoint|challenge|captcha|authwall)\b/i;

export function classifyPage(page: string | PageSnapshot, options: ClassifyOptions = {}): PageStatus {
  const snapshot: PageSnapshot = typeof page === "string" ? { text: page } : page;
  const minTextLength = options.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH;
  const blockedMarkers = options.blockedMarkers ?? DEFAULT_BLOCKED_MARKERS;
  const emptyMarkers = options.emptyMarkers ?? DEFAULT_EMPTY_MARKERS;
  const shellMaxLength = options.shellMaxLength ?? DEFAULT_SHELL_MAX_LENGTH;
  const text = snapshot.text.trim();

  if (snapshot.httpStatus !== undefined && snapshot.httpStatus >= 400) return "blocked";
  if (snapshot.finalUrl && options.requestedUrl && snapshot.finalUrl !== options.requestedUrl && CHALLENGE_URL_PATTERN.test(pathOf(snapshot.finalUrl))) {
    return "blocked";
  }
  if (text.length < minTextLength) return "blocked";
  if (text.length < shellMaxLength && blockedMarkers.some((marker) => marker.test(text))) return "blocked";
  if (emptyMarkers.some((marker) => marker.test(text))) return "empty";
  return "ok";
}

/** True for any status that means the page did not load real content. `empty` is not a failure: the page loaded and said so itself. */
export function isFailedStatus(status: PageStatus): boolean {
  return status === "blocked" || status === "error";
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** The key a CircuitBreaker tracks a URL under. Falls back to the raw string for something that isn't a URL. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export interface PageReadResult {
  readonly status: PageStatus;
  readonly text?: string;
  readonly finalUrl?: string;
  readonly error?: string;
}

/**
 * Loads `url` and classifies it. Uses the client's richer `getPage` when it
 * has one (final URL, HTTP status), otherwise `getPageText`. A thrown load
 * becomes `error`, never an exception — callers decide what to do with it.
 */
export async function readAndClassify(client: BrowserClient, url: string, options: ClassifyOptions = {}): Promise<PageReadResult> {
  let snapshot: PageSnapshot;
  try {
    snapshot = client.getPage ? await client.getPage(url) : { text: await client.getPageText(url) };
  } catch (error) {
    return { status: "error", error: (error as Error).message };
  }
  const status = classifyPage(snapshot, { requestedUrl: url, ...options });
  return { status, text: snapshot.text, ...(snapshot.finalUrl ? { finalUrl: snapshot.finalUrl } : {}) };
}

export interface SessionHealth {
  readonly healthy: boolean;
  readonly status: PageStatus;
  readonly note: string;
}

/** Pre-flight load of a lightweight page. Healthy means real chrome loaded (`ok` or `empty`); anything else means the session or site is the problem, not whatever page comes next. */
export async function checkSessionHealth(client: BrowserClient, probeUrl: string, options: ClassifyOptions = {}): Promise<SessionHealth> {
  const result = await readAndClassify(client, probeUrl, options);
  const healthy = !isFailedStatus(result.status);
  const note = healthy
    ? `Health check passed on ${probeUrl}.`
    : result.status === "error"
      ? `Health check on ${probeUrl} failed to load: ${result.error}`
      : `Health check on ${probeUrl} came back blocked (blank, error shell, HTTP error, or a login/challenge redirect).`;
  return { healthy, status: result.status, note };
}

/**
 * Trips after `threshold` consecutive failed results for the same domain,
 * so a caller stops hammering a site that is evidently blocking it. Any
 * non-failed result (`ok` or `empty`) resets that domain's count. State is
 * per domain: one board tripping never stops another.
 */
export class CircuitBreaker {
  private readonly consecutive = new Map<string, number>();

  constructor(readonly threshold: number = DEFAULT_CIRCUIT_BREAKER_THRESHOLD) {}

  record(domain: string, status: PageStatus): void {
    this.consecutive.set(domain, isFailedStatus(status) ? this.consecutiveFailures(domain) + 1 : 0);
  }

  isOpen(domain: string): boolean {
    return this.consecutiveFailures(domain) >= this.threshold;
  }

  consecutiveFailures(domain: string): number {
    return this.consecutive.get(domain) ?? 0;
  }
}

export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits `ms` between requests so a caller reads as ordinary browsing cadence. `sleep` is injectable so tests never really wait. */
export async function pace(ms: number = DEFAULT_PACE_MS, sleep: Sleep = realSleep): Promise<void> {
  await sleep(ms);
}

/** Paces every request after the first. */
export class Pacer {
  private started = false;

  constructor(
    private readonly ms: number = DEFAULT_PACE_MS,
    private readonly sleep: Sleep = realSleep,
  ) {}

  async beforeRequest(): Promise<void> {
    if (this.started) await pace(this.ms, this.sleep);
    this.started = true;
  }
}

export interface ReadWithRetryOptions {
  readonly classify?: ClassifyOptions;
  /** Pause before the single retry. Defaults to DEFAULT_PACE_MS. */
  readonly retryDelayMs?: number;
  readonly sleep?: Sleep;
}

/**
 * Reads `url`; a failed (blocked/error) load gets exactly one paced retry
 * before the failure is reported. Read-only pages only — never use this for
 * anything that submits.
 */
export async function readWithOneRetry(client: BrowserClient, url: string, options: ReadWithRetryOptions = {}): Promise<PageReadResult & { readonly attempts: number }> {
  const first = await readAndClassify(client, url, options.classify);
  if (!isFailedStatus(first.status)) return { ...first, attempts: 1 };
  await pace(options.retryDelayMs ?? DEFAULT_PACE_MS, options.sleep ?? realSleep);
  const second = await readAndClassify(client, url, options.classify);
  return { ...second, attempts: 2 };
}

/**
 * The line a read Tool prints for a page that didn't load. Says plainly
 * that this is a load failure, so nothing downstream reports it as a
 * quiet or empty page.
 */
export function describeFailedRead(url: string, result: PageReadResult): string {
  const why = result.status === "error" ? `the load failed (${result.error})` : "the page came back blank, as an error shell, with an HTTP error, or redirected to a login/challenge page";
  return `The page at ${url} did not load: ${why}. This is a load failure, not a quiet page — do not report it as having nothing new.`;
}
