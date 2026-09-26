import type { BrowserClient } from "../browser/client";
import {
  CircuitBreaker,
  classifyPage,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_MIN_TEXT_LENGTH,
  DEFAULT_PACE_MS,
  pace,
  realSleep,
} from "../browser/page-health";
import { STANDING_X_TOPICS, xSearchUrl, type XTopic } from "./topics";

export type TopicSweepStatus = "ok" | "blocked" | "skipped";

export interface TopicSweepResult {
  readonly topic: string;
  readonly status: TopicSweepStatus;
  /** The rendered page text for a successful ("ok") result — this still includes legitimately-quiet topics; the agent decides "no real news" from the text, this layer never guesses that itself. */
  readonly text?: string;
  readonly note?: string;
}

export interface XSearchSweepResult {
  readonly sessionHealthy: boolean;
  readonly results: readonly TopicSweepResult[];
}

export interface XSearchSweepOptions {
  readonly topics?: readonly XTopic[];
  /** A lightweight authenticated page checked before the sweep starts. Defaults to the X home timeline. */
  readonly healthCheckUrl?: string;
  /** Rendered text shorter than this is treated as a blocked/blank page, not a legitimately short result. X's normal search/home pages render far more than this even with zero matching posts (nav chrome, trends, footer). */
  readonly minTextLength?: number;
  /** Delay before a same-topic fallback retry and between topics, in ms — paces requests so the sweep itself doesn't look like the kind of rapid-fire browsing that trips X's rate limiting. */
  readonly delayMs?: number;
  /** Consecutive blocked topics after which the sweep stops attempting the rest, instead of continuing to hammer a session that's clearly already blocked. */
  readonly circuitBreakerThreshold?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_HEALTH_CHECK_URL = "https://x.com/home";
/** The sweep's breaker key: every topic is a read against the same X session. */
const SWEEP_BREAKER_DOMAIN = "x.com";

/**
 * Length-only classification, exactly as this sweep has always done it
 * (ADR 0025). The shared module's error-shell markers are switched off
 * here so extracting page-health.ts changed no sweep behavior.
 */
function isBlankOrBlocked(text: string, minTextLength: number): boolean {
  return classifyPage(text, { minTextLength, blockedMarkers: [], emptyMarkers: [] }) === "blocked";
}

async function fetchTopic(
  browserClient: BrowserClient,
  topic: XTopic,
  options: { readonly minTextLength: number; readonly delayMs: number; readonly sleep: (ms: number) => Promise<void> },
): Promise<TopicSweepResult> {
  try {
    const primaryText = await browserClient.getPageText(xSearchUrl(topic.query, { live: true }));
    if (!isBlankOrBlocked(primaryText, options.minTextLength)) {
      return { topic: topic.name, status: "ok", text: primaryText };
    }
  } catch {
    // Latest tab failed outright (crash, timeout, navigation error) — fall through to the fallback below rather than surfacing raw error noise as the result.
  }

  await pace(options.delayMs, options.sleep);

  try {
    const fallbackText = await browserClient.getPageText(xSearchUrl(topic.query, { live: false }));
    if (!isBlankOrBlocked(fallbackText, options.minTextLength)) {
      return { topic: topic.name, status: "ok", text: fallbackText, note: "Latest tab was blank/crashed; recovered via the Top-tab fallback." };
    }
    return { topic: topic.name, status: "blocked", note: "Both the Latest tab and the Top-tab fallback came back blank." };
  } catch (error) {
    return { topic: topic.name, status: "blocked", note: `Latest tab was blank, and the Top-tab fallback also failed: ${(error as Error).message}` };
  }
}

/**
 * Runs the standing X search-intel sweep with the durability the raw
 * "spawn a browser task per topic" approach lacked (ADR 0025):
 *
 * 1. A pre-flight health check on a lightweight authenticated page. If the
 *    @WoozyBets session itself is blocked/throttled/logged out, every topic
 *    would come back blank for a reason that has nothing to do with that
 *    topic — so the sweep says that plainly once, up front, instead of
 *    silently reporting eight "no real news" topics.
 * 2. Per-topic fallback: a blank/crashed Latest-tab (`f=live`) result gets
 *    one retry on the Top tab after a pause, before being called blocked.
 * 3. A circuit breaker: three consecutive blocked topics stop the sweep
 *    from continuing to hammer an evidently-blocked session for the
 *    remaining topics.
 * 4. An enforced pause between topics and before a fallback retry, so the
 *    sweep itself doesn't add to whatever throttling triggered the
 *    original failure.
 */
export async function runXSearchSweep(browserClient: BrowserClient, options: XSearchSweepOptions = {}): Promise<XSearchSweepResult> {
  const topics = options.topics ?? STANDING_X_TOPICS;
  const healthCheckUrl = options.healthCheckUrl ?? DEFAULT_HEALTH_CHECK_URL;
  const minTextLength = options.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH;
  const delayMs = options.delayMs ?? DEFAULT_PACE_MS;
  const circuitBreakerThreshold = options.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
  const sleep = options.sleep ?? realSleep;

  let sessionHealthy: boolean;
  try {
    const healthText = await browserClient.getPageText(healthCheckUrl);
    sessionHealthy = !isBlankOrBlocked(healthText, minTextLength);
  } catch {
    sessionHealthy = false;
  }

  if (!sessionHealthy) {
    return {
      sessionHealthy: false,
      results: topics.map((topic) => ({
        topic: topic.name,
        status: "skipped" as const,
        note: "Skipped: the @WoozyBets session failed its pre-sweep health check (likely blocked, throttled, or logged out). Running the full sweep anyway would just report false blanks for every topic and risk compounding the block.",
      })),
    };
  }

  const results: TopicSweepResult[] = [];
  const breaker = new CircuitBreaker(circuitBreakerThreshold);

  for (const topic of topics) {
    if (breaker.isOpen(SWEEP_BREAKER_DOMAIN)) {
      results.push({
        topic: topic.name,
        status: "skipped",
        note: `Skipped: ${breaker.consecutiveFailures(SWEEP_BREAKER_DOMAIN)} consecutive topics came back blocked, so the sweep stopped early instead of continuing to hammer a throttled session.`,
      });
      continue;
    }

    if (results.length > 0) {
      await pace(delayMs, sleep);
    }

    const result = await fetchTopic(browserClient, topic, { minTextLength, delayMs, sleep });
    results.push(result);
    breaker.record(SWEEP_BREAKER_DOMAIN, result.status === "blocked" ? "blocked" : "ok");
  }

  return { sessionHealthy: true, results };
}
