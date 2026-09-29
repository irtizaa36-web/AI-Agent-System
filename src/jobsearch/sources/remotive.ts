import type { RawPosting } from "../records";
import { fetchJson, jitter, type Source } from "./source";
import { marketingQueriesFor, postedWithinDays, titleMatchesMarketingTerms } from "./marketing-queries";

/**
 * Remotive's public remote-jobs API. No key; the feed is the whole board,
 * so role filtering happens locally against the marketing query terms and
 * the 3-day recency window.
 *
 * Usage terms (stated in the API response itself): jobs are delayed ~24h,
 * attribution to Remotive is required, and they ask for no more than 4
 * requests/day — this source makes exactly one request per run.
 */

export const REMOTIVE_SOURCE_ID = "remotive";
export const REMOTIVE_API_URL = "https://remotive.com/api/remote-jobs?limit=200";

interface RemotiveJob {
  readonly title?: string;
  readonly company_name?: string;
  readonly candidate_required_location?: string;
  readonly publication_date?: string;
  readonly url?: string;
  readonly description?: string;
}

interface RemotiveResponse {
  readonly jobs?: readonly RemotiveJob[];
}

/** Pure: response body -> postings. Tested without a network call. */
export function parseRemotiveJobs(
  body: RemotiveResponse,
  queries: readonly string[],
  sourceId: string,
  fetchedAt: string,
): readonly RawPosting[] {
  return (body.jobs ?? []).flatMap((job) => {
    const title = job.title?.trim() ?? "";
    if (title.length === 0) return [];
    if (!titleMatchesMarketingTerms(title, queries)) return [];
    if (!postedWithinDays(job.publication_date)) return [];
    // The location normalizer trusts the structured location string and
    // treats a location containing "Remote" as remote — so every Remotive
    // posting is emitted as Remote, qualified by the employer's stated
    // candidate requirement ("USA Only", "Worldwide", ...).
    const requirement = job.candidate_required_location?.trim();
    const location = requirement ? `Remote (${requirement})` : "Remote";
    return [
      {
        sourceId,
        url: job.url ?? "",
        title,
        company: job.company_name?.trim() ?? "",
        location,
        body: job.description ?? "",
        postedAt: job.publication_date ?? null,
        fetchedAt,
      },
    ];
  });
}

export function createRemotiveSource(profileTitles: readonly string[] = []): Source {
  const queries = marketingQueriesFor(profileTitles);
  return {
    id: REMOTIVE_SOURCE_ID,
    company: null,
    async fetch() {
      // One request per run — well within Remotive's 4-requests/day guidance.
      await jitter();
      const body = await fetchJson<RemotiveResponse>(REMOTIVE_API_URL);
      return parseRemotiveJobs(body, queries, REMOTIVE_SOURCE_ID, new Date().toISOString());
    },
  };
}
