import type { BrowserClient } from "./client";
import { browserSessionPath, hasBrowserSession } from "./session";

export interface RealBrowserClientOptions {
  /**
   * Whether a saved `browser login` session is mandatory for this site.
   * Defaults to true (ADR 0007's original Sermo-style design: a private,
   * authenticated feed with no meaningful public-anonymous mode). Set to
   * false for a public page that needs no login at all (e.g. a job
   * board's public search results, ADR 0012) — a session is still used if
   * one happens to exist for the site, just never required.
   */
  readonly requireSession?: boolean;
}

/**
 * The Playwright-backed BrowserClient (ADR 0007). `playwright` is loaded via
 * a dynamic import, the same pattern tunnel.ts uses for `@inkbox/sdk`, so
 * that tests running against FakeBrowserClient never need the browser
 * binary installed.
 */
export class RealBrowserClient implements BrowserClient {
  private readonly requireSession: boolean;

  constructor(
    readonly siteName: string,
    options: RealBrowserClientOptions = {},
  ) {
    this.requireSession = options.requireSession ?? true;
  }

  async getPageText(url: string): Promise<string> {
    const hasSession = hasBrowserSession(this.siteName);
    if (this.requireSession && !hasSession) {
      throw new Error(
        `No saved browser session for "${this.siteName}". Run \`browser login ${this.siteName} <login-url>\` first, log in manually in the window that opens, then retry.`,
      );
    }

    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const context = hasSession ? await browser.newContext({ storageState: browserSessionPath(this.siteName) }) : await browser.newContext();
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle" });
      return await page.evaluate(() => document.body.innerText);
    } finally {
      await browser.close();
    }
  }
}

/**
 * Returns a real client only when a session has actually been saved for
 * `siteName` — never a half-configured one. Callers fall back to a fake
 * otherwise, the same pattern as createDefaultInkboxClient. For a site
 * that genuinely needs a login (e.g. Sermo).
 */
export function createBrowserClientFromSession(siteName: string): RealBrowserClient | undefined {
  return hasBrowserSession(siteName) ? new RealBrowserClient(siteName) : undefined;
}

/**
 * Always returns a real client, never a fake one — for a public page that
 * needs no login at all (ADR 0012), there's no "half-configured" state to
 * guard against the way there is for a credentialed site.
 */
export function createPublicBrowserClient(siteName: string): RealBrowserClient {
  return new RealBrowserClient(siteName, { requireSession: false });
}
