import type { RawPosting } from "../records";
import { fetchJson, jitter, type Source } from "./source";
import { marketingQueriesFor, postedWithinDays, titleMatchesMarketingTerms } from "./marketing-queries";

/**
 * RemoteOK's public JSON API. No key; returns the whole board, so role
 * filtering happens locally against the marketing query terms and the 3-day
 * recency window.
 *
 * Two response quirks, both handled in parseRemoteOkJobs:
 * - The first array element is a legal/ToS notice, not a job — job rows are
 *   identified by the presence of a `position`.
 * - `location` is often empty or free text; every RemoteOK posting is a
 *   remote job, so locations are emitted as Remote, qualified by the stated
 *   location when there is one.
 *
 * Their terms ask for a link back and a mention of Remote OK as the source.
 */

export const REMOTEOK_SOURCE_ID = "remoteok";
export const REMOTEOK_API_URL = "https://remoteok.com/api";

interface RemoteOkJob {
  readonly id?: string;
  readonly slug?: string;
  readonly date?: string;
  readonly epoch?: number;
  readonly company?: string;
  readonly position?: string;
  readonly tags?: readonly string[];
  readonly description?: string;
  readonly location?: string;
  readonly url?: string;
  readonly apply_url?: string;
}

type RemoteOkResponse = readonly RemoteOkJob[];

/** Pure: response body -> postings. Tested without a network call. */
export function parseRemoteOkJobs(
  body: unknown,
  queries: readonly string[],
  sourceId: string,
  fetchedAt: string,
): readonly RawPosting[] {
  const rows: readonly RemoteOkJob[] = Array.isArray(body) ? body : [];
  return rows.flatMap((job) => {
    // Skips the leading legal-notice element and any other non-job row.
    const title = job.position?.trim() ?? "";
    if (title.length === 0) return [];
    if (!titleMatchesMarketingTerms(title, queries)) return [];
    const postedAt = job.date ?? (typeof job.epoch === "number" ? new Date(job.epoch * 1000).toISOString() : null);
    if (!postedWithinDays(postedAt)) return [];
    const stated = job.location?.trim();
    const location = stated ? `Remote (${stated})` : "Remote";
    return [
      {
        sourceId,
        url: job.url || job.apply_url || "",
        title,
        company: job.company?.trim() ?? "",
        location,
        body: job.description ?? "",
        postedAt,
        fetchedAt,
      },
    ];
  });
}

export function createRemoteOkSource(profileTitles: readonly string[] = []): Source {
  const queries = marketingQueriesFor(profileTitles);
  return {
    id: REMOTEOK_SOURCE_ID,
    company: null,
    async fetch() {
      // RemoteOK asks for a descriptive User-Agent on API use; the shared
      // fetchJson already identifies this pipeline honestly (see source.ts).
      await jitter();
      const body = await fetchJson<unknown>(REMOTEOK_API_URL);
      return parseRemoteOkJobs(body, queries, REMOTEOK_SOURCE_ID, new Date().toISOString());
    },
  };
}
