/**
 * The standing X/Twitter topics the search-intel sweep covers, and the
 * search-results URL it visits for each one (ADR 0025).
 */
export interface XTopic {
  readonly name: string;
  readonly query: string;
}

export const STANDING_X_TOPICS: readonly XTopic[] = [
  { name: "NFL betting", query: "NFL betting odds" },
  { name: "College football betting", query: "college football betting odds" },
  { name: "NBA", query: "NBA" },
  { name: "UFC/MMA", query: "UFC MMA" },
  { name: "Soccer", query: "soccer" },
  { name: "Tech/AI", query: "AI" },
  { name: "Stocks", query: "stocks market" },
  { name: "Houston", query: "Houston" },
];

/**
 * Builds an x.com search URL for `query`. `live: true` (the default) is the
 * Latest tab (`f=live`) the skill originally always used; `live: false`
 * drops that parameter for the Top tab, used as the fallback query when the
 * Latest tab comes back blank (ADR 0025) — X's Top tab serves cached,
 * already-ranked results rather than the continuously-polling live stream,
 * so it's less likely to hit the same block/timeout.
 */
export function xSearchUrl(query: string, options: { readonly live?: boolean } = {}): string {
  const params = new URLSearchParams({ q: query, src: "typed_query" });
  if (options.live ?? true) {
    params.set("f", "live");
  }
  return `https://x.com/search?${params.toString()}`;
}
