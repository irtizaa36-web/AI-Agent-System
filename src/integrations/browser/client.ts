/**
 * The port for reading an authenticated web page's rendered text (ADR
 * 0007). Deliberately has exactly one operation: this project has no
 * `click`/`type`/`submit` capability anywhere, so a Tool built on this port
 * cannot complete or submit anything on a page, no matter what an agent is
 * instructed to do — that's a structural guarantee, not a prompt-level one.
 */
export interface BrowserClient {
  /** Which site this client holds an authenticated session for, e.g. "sermo". Used only for error messages and test fixtures. */
  readonly siteName: string;

  /**
   * Navigates to `url` using the persisted, human-authenticated session for
   * this site, and returns the page's rendered visible text once
   * JavaScript has finished running. Read-only.
   */
  getPageText(url: string): Promise<string>;
}
