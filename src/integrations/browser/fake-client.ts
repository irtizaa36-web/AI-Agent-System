import type { BrowserClient, PageSnapshot } from "./client";

/**
 * One fixture page: a text or snapshot, an Error to throw, or an array of
 * those served on successive reads (the last one repeats) — so a test can
 * script "blocked, then ok on retry".
 */
export type FakePage = string | PageSnapshot | Error;
export type FakePageFixture = FakePage | readonly FakePage[];

/**
 * An in-memory BrowserClient for tests: returns canned text for known URLs,
 * and a clear error for anything else, rather than ever touching a real
 * browser. See real-client.ts for the Playwright-backed implementation.
 */
export class FakeBrowserClient implements BrowserClient {
  /** Every URL read, in order — lets a test assert a read was (or wasn't) attempted. */
  public readonly requestedUrls: string[] = [];
  private readonly readCounts = new Map<string, number>();

  constructor(
    readonly siteName: string,
    private readonly pages: ReadonlyMap<string, FakePageFixture> = new Map(),
  ) {}

  async getPageText(url: string): Promise<string> {
    return (await this.getPage(url)).text;
  }

  async getPage(url: string): Promise<PageSnapshot> {
    this.requestedUrls.push(url);
    const fixture = this.pages.get(url);
    if (fixture === undefined) {
      throw new Error(`FakeBrowserClient has no fixture page for "${url}" (site "${this.siteName}")`);
    }
    const count = this.readCounts.get(url) ?? 0;
    this.readCounts.set(url, count + 1);
    const page = Array.isArray(fixture) ? (fixture as readonly FakePage[])[Math.min(count, fixture.length - 1)]! : (fixture as FakePage);
    if (page instanceof Error) throw page;
    return typeof page === "string" ? { text: page, finalUrl: url } : page;
  }
}
