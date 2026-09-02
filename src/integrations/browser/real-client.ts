import type { BrowserClient } from "./client";
import { browserSessionPath, hasBrowserSession } from "./session";

/**
 * The Playwright-backed BrowserClient (ADR 0007). `playwright` is loaded via
 * a dynamic import, the same pattern tunnel.ts uses for `@inkbox/sdk`, so
 * that tests running against FakeBrowserClient never need the browser
 * binary installed.
 */
export class RealBrowserClient implements BrowserClient {
  constructor(readonly siteName: string) {}

  async getPageText(url: string): Promise<string> {
    if (!hasBrowserSession(this.siteName)) {
      throw new Error(
        `No saved browser session for "${this.siteName}". Run \`browser login ${this.siteName} <login-url>\` first, log in manually in the window that opens, then retry.`,
      );
    }

    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ storageState: browserSessionPath(this.siteName) });
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
 * otherwise, the same pattern as createDefaultInkboxClient.
 */
export function createBrowserClientFromSession(siteName: string): RealBrowserClient | undefined {
  return hasBrowserSession(siteName) ? new RealBrowserClient(siteName) : undefined;
}
