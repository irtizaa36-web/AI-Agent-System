import type { BrowserClient } from "./client";

/**
 * An in-memory BrowserClient for tests: returns canned text for known URLs,
 * and a clear error for anything else, rather than ever touching a real
 * browser. See real-client.ts for the Playwright-backed implementation.
 */
export class FakeBrowserClient implements BrowserClient {
  constructor(
    readonly siteName: string,
    private readonly pages: ReadonlyMap<string, string> = new Map(),
  ) {}

  async getPageText(url: string): Promise<string> {
    const text = this.pages.get(url);
    if (text === undefined) {
      throw new Error(`FakeBrowserClient has no fixture page for "${url}" (site "${this.siteName}")`);
    }
    return text;
  }
}
