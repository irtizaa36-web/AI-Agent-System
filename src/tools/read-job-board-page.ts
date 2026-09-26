import type { Tool } from "./tool";
import type { BrowserClient } from "../integrations/browser/client";
import {
  checkSessionHealth,
  CircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  describeFailedRead,
  domainOf,
  isFailedStatus,
  Pacer,
  readWithOneRetry,
  realSleep,
  type ReadWithRetryOptions,
} from "../integrations/browser/page-health";

interface ReadJobBoardPageInput {
  readonly url?: string;
  readonly urls?: readonly string[];
}

function isReadJobBoardPageInput(input: unknown): input is ReadJobBoardPageInput {
  if (typeof input !== "object" || input === null) return false;
  const { url, urls } = input as { url?: unknown; urls?: unknown };
  const hasUrl = typeof url === "string";
  const hasUrls = Array.isArray(urls) && urls.length > 0 && urls.every((u) => typeof u === "string");
  return hasUrl || hasUrls;
}

export interface ReadJobBoardPageOptions extends ReadWithRetryOptions {
  readonly circuitBreakerThreshold?: number;
}

function boardBaseUrl(url: string): string {
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return url;
  }
}

/**
 * Reads the rendered visible text of a public job-board search results
 * page (ADR 0012) — no login required, unlike read-web-page's Sermo
 * session. Read-only, same as read-web-page; this Tool has no way to
 * click, apply to, or save a job listing.
 *
 * Blocked-vs-quiet hardening (ADR 0026): before the first read of a board,
 * its base URL is health-checked, and a board that fails is skipped rather
 * than read. Each read gets one paced retry if blocked. A per-board circuit
 * breaker, held for the life of this Tool instance (one CLI run), skips a
 * board after three consecutive blocked reads while the other boards
 * carry on.
 */
export function createReadJobBoardPageTool(browserClient: BrowserClient, options: ReadJobBoardPageOptions = {}): Tool {
  const boardHealth = new Map<string, { healthy: boolean; note: string }>();
  const breaker = new CircuitBreaker(options.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD);
  const pacer = new Pacer(options.retryDelayMs, options.sleep ?? realSleep);

  async function readOne(url: string): Promise<string> {
    const board = domainOf(url);

    if (!boardHealth.has(board)) {
      await pacer.beforeRequest();
      const health = await checkSessionHealth(browserClient, boardBaseUrl(url), options.classify);
      boardHealth.set(board, { healthy: health.healthy, note: health.note });
    }
    const health = boardHealth.get(board)!;
    if (!health.healthy) {
      return `## ${url} [skipped]\nstatus: blocked\nSkipped: ${board} failed its health check, so no read was attempted. ${health.note}`;
    }
    if (breaker.isOpen(board)) {
      return `## ${url} [skipped]\nstatus: blocked\nSkipped: ${board} tripped its circuit breaker after ${breaker.consecutiveFailures(board)} consecutive blocked reads this run.`;
    }

    await pacer.beforeRequest();
    const result = await readWithOneRetry(browserClient, url, options);
    breaker.record(board, result.status);
    if (isFailedStatus(result.status)) {
      return `## ${url} [${result.status}]\nstatus: ${result.status}\n${describeFailedRead(url, result)}`;
    }
    return `## ${url} [${result.status}]\nstatus: ${result.status}\n\n${result.text ?? ""}`;
  }

  return {
    name: "read-job-board-page",
    description:
      'Reads the rendered visible text of one or more public job-board search results pages (e.g. a job search URL with location/keyword filters already applied). Pass "url" for one page or "urls" for several boards in one run. Each page\'s section has a "status: ok|empty|blocked|error" line; "blocked" or "error" means the page did not load, which is not the same as zero jobs. Read-only: there is no way for this tool to click, apply, or save a listing.',
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, urls: { type: "array", items: { type: "string" } } },
    },
    async execute(input: unknown): Promise<string> {
      if (!isReadJobBoardPageInput(input)) {
        throw new Error('read-job-board-page tool requires an input of the shape { "url": string } or { "urls": string[] }');
      }
      const urls = input.urls && input.urls.length > 0 ? input.urls : [input.url!];
      const sections: string[] = [];
      for (const url of urls) {
        sections.push(await readOne(url));
      }
      return sections.join("\n\n");
    },
  };
}
