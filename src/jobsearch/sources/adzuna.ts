import type { RawPosting } from "../records";
import { fetchJson, jitter, mapWithConcurrency, type Source } from "./source";
import { MARKETING_QUERY_TERMS, postedWithinDays } from "./marketing-queries";

/**
 * Adzuna's public job search API (https://developer.adzuna.com).
 *
 * Credentials come from the ADZUNA_APP_ID / ADZUNA_APP_KEY environment
 * variables — never hardcoded, never logged. When either is missing the
 * factory returns undefined and the caller logs a skip line, so the rest of
 * the pipeline runs unaffected.
 *
 * One request per marketing role query (results_per_page=30, max_days_old=3),
 * run at low concurrency. A job matching several queries is deduped locally
 * by its redirect URL before the pipeline's own cross-source dedupe sees it.
 */

export const ADZUNA_SOURCE_ID = "adzuna:us";
const ADZUNA_BASE_URL = "https://api.adzuna.com/v1/api/jobs/us/search/1";

/** Pure: query + credentials -> request URL. Tested without a network call. */
export function adzunaSearchUrl(query: string, appId: string, appKey: string): string {
  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    what: query,
    results_per_page: "30",
    max_days_old: "3",
  });
  return `${ADZUNA_BASE_URL}?${params.toString()}`;
}

interface AdzunaResult {
  readonly id?: string;
  readonly title?: string;
  readonly company?: { readonly display_name?: string };
  readonly location?: { readonly display_name?: string };
  readonly description?: string;
  readonly redirect_url?: string;
  readonly created?: string;
}

interface AdzunaResponse {
  readonly results?: readonly AdzunaResult[];
}

/** Pure: one query's response body -> postings. Tested without a network call. */
export function parseAdzunaResults(body: unknown, sourceId: string, fetchedAt: string): readonly RawPosting[] {
  const results = (body as AdzunaResponse | null | undefined)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((result) => {
    const url = result.redirect_url ?? "";
    if (url.length === 0) return [];
    const title = result.title?.trim() ?? "";
    if (title.length === 0) return [];
    // Belt and braces: the API's max_days_old=3 already enforces the window.
    if (!postedWithinDays(result.created)) return [];
    return [
      {
        sourceId,
        url,
        title,
        company: result.company?.display_name?.trim() ?? "",
        location: result.location?.display_name?.trim() ?? "",
        body: result.description ?? "",
        postedAt: result.created ?? null,
        fetchedAt,
      },
    ];
  });
}

/**
 * Reads Adzuna credentials from the environment. Returns undefined when
 * either is missing or blank — the caller treats that as "skip with a log
 * line", never as an error.
 */
export function createAdzunaSource(): Source | undefined {
  const appId = process.env["ADZUNA_APP_ID"]?.trim();
  const appKey = process.env["ADZUNA_APP_KEY"]?.trim();
  if (!appId || !appKey) return undefined;
  return {
    id: ADZUNA_SOURCE_ID,
    company: null,
    async fetch() {
      await jitter();
      const fetchedAt = new Date().toISOString();
      const perQuery = await mapWithConcurrency(MARKETING_QUERY_TERMS, 2, async (query) => {
        const body = await fetchJson<unknown>(adzunaSearchUrl(query, appId, appKey));
        return parseAdzunaResults(body, ADZUNA_SOURCE_ID, fetchedAt);
      });
      // One job can match several role queries — dedupe locally by URL.
      const seen = new Set<string>();
      const postings: RawPosting[] = [];
      for (const posting of perQuery.flat()) {
        if (seen.has(posting.url)) continue;
        seen.add(posting.url);
        postings.push(posting);
      }
      return postings;
    },
  };
}
