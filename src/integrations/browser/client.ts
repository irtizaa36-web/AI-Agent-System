/**
 * What a page load looked like, with enough signal to tell a blocked page
 * from a quiet one (ADR 0026): the rendered text plus, when the client can
 * see them, the URL the browser ended up on and the HTTP status.
 */
export interface PageSnapshot {
  readonly text: string;
  /** The URL after any redirects — a bounce to a login or challenge page shows up here. */
  readonly finalUrl?: string;
  /** The main document's HTTP status, when known. */
  readonly httpStatus?: number;
}

/**
 * The port for reading an authenticated web page's rendered text (ADR
 * 0007). Deliberately read-only: this project has no
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

  /**
   * Same read as `getPageText`, plus the final URL and HTTP status so
   * page-health.ts can classify the load (ADR 0026). Optional: a client
   * without it is classified from its text alone. Read-only.
   */
  getPage?(url: string): Promise<PageSnapshot>;
}
