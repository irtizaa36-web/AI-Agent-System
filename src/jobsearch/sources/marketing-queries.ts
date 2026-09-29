/**
 * Marketing role queries for Shivani's public job-board sources.
 *
 * Remotive and RemoteOK publish broad remote feeds with no server-side role
 * filter, so these terms are matched locally against job titles. Adzuna takes
 * them as its `what` query directly. Developer roles are never queried here —
 * Shivani's search is marketing-only.
 */

/**
 * The explicit marketing role terms for Shivani's search. Each term is
 * specific enough to avoid product-management and engineering titles:
 * "Product" alone would match every product manager on the board, so the
 * term is "Product Marketing".
 */
export const MARKETING_QUERY_TERMS: readonly string[] = [
  "Product Marketing",
  "Partner Marketing",
  "Field Marketing",
  "Event Marketing",
  "Customer Marketing",
  "Marketing Program",
  "Integrated Marketing",
  "Lifecycle Marketing",
  "Demand Generation",
  "Marketing Operations",
  "Content Marketing",
  "Marketing Manager",
];

/** Case-insensitive substring match of a job title against the query terms. */
export function titleMatchesMarketingTerms(title: string, terms: readonly string[] = MARKETING_QUERY_TERMS): boolean {
  const lowered = title.toLowerCase();
  return terms.some((term) => lowered.includes(term.toLowerCase()));
}

/**
 * Merges a profile's configured title hints (e.g. preferences.json `titles`)
 * with the built-in marketing terms. Profile titles come first and win the
 * dedupe, so a profile can narrow its board queries without a code change.
 * Matching is additive — extra terms only add matches, never remove any.
 */
export function marketingQueriesFor(profileTitles: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const term of [...(profileTitles ?? []), ...MARKETING_QUERY_TERMS]) {
    const trimmed = term.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(trimmed);
  }
  return queries;
}

/**
 * Recency window for public board fetches, in days. Mirrors
 * maxPostingAgeDays in Shivani's preferences.json — the pipeline re-applies
 * that filter itself, but filtering at the source keeps each fetch small and
 * honors the window even for boards whose dates are index/crawl stamps
 * rather than true post dates.
 */
export const MAX_BOARD_POSTING_AGE_DAYS = 3;

/**
 * True when a posting's stated date is within the recency window. A missing
 * or unparseable date is never a rejection — same "don't guess" rule as the
 * pipeline's own maxPostingAgeDays. Dates stamped in the future (some boards
 * stamp their crawl/index time) are clamped to now rather than rejected.
 */
export function postedWithinDays(
  postedAt: string | null | undefined,
  maxDays: number = MAX_BOARD_POSTING_AGE_DAYS,
  nowMs: number = Date.now(),
): boolean {
  if (!postedAt) return true;
  const postedMs = Date.parse(postedAt);
  if (Number.isNaN(postedMs)) return true;
  const clampedMs = Math.min(postedMs, nowMs);
  return nowMs - clampedMs <= maxDays * 24 * 60 * 60 * 1000;
}
