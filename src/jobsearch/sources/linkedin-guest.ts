import type { RawPosting } from "../records";
import { htmlToText } from "../normalize";
import { postedWithinDays } from "./marketing-queries";
import { USER_AGENT, type Source } from "./source";

/**
 * LinkedIn's anonymous jobs-guest endpoints (ADR 0028, a narrow exception to
 * ADR 0013). These are the pages LinkedIn serves to any logged-out visitor:
 *
 *   search cards:  /jobs-guest/jobs/api/seeMoreJobPostings/search?...
 *   job detail:    /jobs-guest/jobs/api/jobPosting/<id>
 *
 * Guest-only, forever. There is deliberately no configuration surface here
 * that could hold a credential: no env var, no cookie, no header other than
 * the project's honest User-Agent. A response that turns out to be a login,
 * authwall or CAPTCHA page ends the run — it is never worked around.
 *
 * Low frequency by construction. This source runs once a day inside the
 * existing scheduled pipeline run and has no timer of its own; each run is
 * capped at MAX_SEARCH_REQUESTS + MAX_DETAIL_REQUESTS requests, made
 * sequentially with a human-scale gap, and nothing is ever retried.
 */

export const LINKEDIN_GUEST_SOURCE_ID = "linkedin:guest";

const GUEST_API = "https://www.linkedin.com/jobs-guest/jobs/api";

/** Hard per-run request caps. A daily pull, not a crawl. */
export const MAX_SEARCH_REQUESTS = 8;
export const MAX_DETAIL_REQUESTS = 30;

/** Cards older than this are never worth a detail request ("never older than a week"). */
export const MAX_CARD_AGE_DAYS = 7;

const MIN_GAP_MS = 2_500;
const MAX_GAP_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;

export interface LinkedInSearchPlan {
  readonly keywords: string;
  readonly location: string;
  /** LinkedIn's own remote work-type filter (f_WT=2). */
  readonly remote: boolean;
  /** Zero-based result offsets, ten cards per page. */
  readonly starts: readonly number[];
}

/**
 * Where to look, mirroring Shivani's locked location rules: US-remote, or
 * Houston / Dallas / New York. Roles are judged on experience fit, not
 * title, but the search still has to ask LinkedIn *something* — these are the
 * marketing-program queries her resume supports.
 */
export const DEFAULT_SEARCH_PLANS: readonly LinkedInSearchPlan[] = [
  { keywords: "Marketing Program Manager", location: "United States", remote: true, starts: [0, 10] },
  { keywords: "Product Marketing Manager", location: "United States", remote: true, starts: [0] },
  { keywords: "Partner Marketing Manager", location: "United States", remote: true, starts: [0] },
  { keywords: "Marketing Program Manager", location: "Houston, TX", remote: false, starts: [0] },
  { keywords: "Marketing Program Manager", location: "Dallas, TX", remote: false, starts: [0] },
  { keywords: "Marketing Program Manager", location: "New York, NY", remote: false, starts: [0] },
];

/** Pure: search plan + offset -> request URL. Past-week window (f_TPR=r604800). */
export function linkedinSearchUrl(plan: Pick<LinkedInSearchPlan, "keywords" | "location" | "remote">, start: number): string {
  const params = new URLSearchParams({
    keywords: plan.keywords,
    location: plan.location,
    f_TPR: "r604800",
    start: String(start),
  });
  if (plan.remote) params.set("f_WT", "2");
  return `${GUEST_API}/seeMoreJobPostings/search?${params.toString()}`;
}

export function linkedinDetailUrl(jobId: string): string {
  return `${GUEST_API}/jobPosting/${encodeURIComponent(jobId)}`;
}

export interface LinkedInCard {
  readonly jobId: string;
  readonly title: string;
  readonly company: string;
  readonly location: string;
  /** The job-view URL exactly as the card links to it, tracking parameters removed. */
  readonly url: string;
  /** The card's machine-readable date (YYYY-MM-DD), when present. */
  readonly listDate: string | null;
}

export interface LinkedInDetail {
  readonly title: string;
  readonly company: string;
  readonly location: string;
  /** ISO timestamp derived from the page's relative age ("5 hours ago"), when stated. */
  readonly postedAt: string | null;
  readonly applicantCount: number | null;
  /** Description HTML, exactly as served. */
  readonly descriptionHtml: string;
  /** Text of the compensation block, when the page has one. */
  readonly compensation: string | null;
  /** Non-LinkedIn (or externalApply-wrapped) apply URL, when the page exposes one. */
  readonly applyUrl: string | null;
  readonly criteria: readonly (readonly [string, string])[];
  readonly closed: boolean;
}

/** Thrown when LinkedIn signals throttling, a login wall or a CAPTCHA. The run stops; nothing retries. */
export class LinkedInBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkedInBlockedError";
  }
}

const text = (html: string | undefined): string => (html ? htmlToText(html).replace(/\s+/g, " ").trim() : "");

/** First element whose class list contains `cls` (as a whole class token). Returns its inner HTML. */
function innerByClass(html: string, cls: string): string | undefined {
  const pattern = new RegExp(
    `<(\\w+)\\b[^>]*class="[^"]*(?<![\\w-])${cls}(?![\\w-])[^"]*"[^>]*>([\\s\\S]*?)</\\1>`,
    "i",
  );
  return pattern.exec(html)?.[2];
}

/** Keeps only a linkedin.com job-view link, with tracking parameters and fragment removed. */
function canonicalJobUrl(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href.replace(/&amp;/g, "&"));
    if (url.protocol !== "https:" || !/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    if (!url.pathname.startsWith("/jobs/view/")) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Pure: search-results HTML -> job cards. A card with no job id or no job-view link is skipped, never guessed. */
export function parseSearchCards(html: string): readonly LinkedInCard[] {
  const cards: LinkedInCard[] = [];
  for (const match of html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const block = match[1] ?? "";
    const jobId = /urn:li:jobPosting:(\d+)/.exec(block)?.[1];
    const url = canonicalJobUrl(/<a[^>]*class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/i.exec(block)?.[1]);
    const title = text(innerByClass(block, "base-search-card__title"));
    const company = text(innerByClass(block, "base-search-card__subtitle"));
    if (!jobId || !url || title.length === 0 || company.length === 0) continue;
    cards.push({
      jobId,
      title,
      company,
      location: text(innerByClass(block, "job-search-card__location")),
      url,
      listDate: /<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/i.exec(block)?.[1] ?? null,
    });
  }
  return cards;
}

const UNIT_MS: Readonly<Record<string, number>> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

/** Pure: "5 hours ago" / "2 weeks ago" -> ISO timestamp. Anything else is unknown (null), never guessed. */
export function parseRelativeAge(label: string, nowMs: number): string | null {
  if (/\bjust now\b/i.test(label)) return new Date(nowMs).toISOString();
  const match = /(\d+)\s*(minute|hour|day|week|month)s?\s+ago/i.exec(label);
  if (!match) return null;
  const unitMs = UNIT_MS[(match[2] as string).toLowerCase()] as number;
  return new Date(nowMs - Number.parseInt(match[1] as string, 10) * unitMs).toISOString();
}

/** Pure: "59 applicants" / "Over 200 applicants" / "Be among the first 25 applicants" -> number, else null. */
export function parseApplicantCount(label: string): number | null {
  const match = /(\d[\d,]*)\s+applicants?/i.exec(label) ?? /first\s+(\d[\d,]*)\s+applicants?/i.exec(label);
  if (!match) return null;
  const value = Number.parseInt((match[1] as string).replace(/,/g, ""), 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Pure: the apply link, only when the page itself exposes one. Guest pages
 * for Easy-Apply-style roles gate Apply behind a sign-in modal and expose no
 * URL — for those the caller falls back to the job-view URL, which is still a
 * real link taken from the page. Never constructed.
 */
export function parseApplyUrl(html: string): string | null {
  const raw = /<code[^>]*id="applyUrl"[^>]*>\s*<!--\s*"?([^"\s]+)"?\s*-->/i.exec(html)?.[1];
  if (!raw) return null;
  try {
    let url = new URL(raw.replace(/&amp;/g, "&"));
    if (/(^|\.)linkedin\.com$/i.test(url.hostname)) {
      // LinkedIn wraps off-site apply links: .../externalApply/<id>?url=<real>
      const wrapped = url.searchParams.get("url");
      if (!wrapped) return null;
      url = new URL(wrapped);
    }
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Pure: job-detail HTML -> detail fields. Returns null when the page is not a job page at all. */
export function parseJobDetail(html: string, nowMs: number): LinkedInDetail | null {
  const descriptionHtml = /show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1];
  const title = text(innerByClass(html, "top-card-layout__title"));
  if (descriptionHtml === undefined || title.length === 0) return null;

  const flavourLocation = /<span[^>]*class="topcard__flavor topcard__flavor--bullet"[^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1];
  const criteria: (readonly [string, string])[] = [];
  for (const item of html.matchAll(
    /description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>[\s\S]*?description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/gi,
  )) {
    const key = text(item[1]);
    const value = text(item[2]);
    if (key && value) criteria.push([key, value]);
  }

  return {
    title,
    company: text(innerByClass(html, "topcard__org-name-link")),
    location: text(flavourLocation),
    postedAt: parseRelativeAge(text(innerByClass(html, "posted-time-ago__text")), nowMs),
    applicantCount: parseApplicantCount(text(innerByClass(html, "num-applicants__caption"))),
    descriptionHtml,
    compensation: text(innerByClass(html, "compensation__salary")) || null,
    applyUrl: parseApplyUrl(html),
    criteria,
    closed: /no longer accepting applications/i.test(html),
  };
}

/**
 * The shared salary parser reads "$120,000-$150,000" but not LinkedIn's
 * "$120,000.00/yr - $150,000.00/yr". Rewriting the cents and the per-year
 * suffix lets the *existing* parser (and therefore the existing salary floor)
 * see the figure — no new salary semantics, just a format it already knows.
 */
export function normalizeCompensationText(input: string): string {
  return input
    .replace(/(\$\s?\d[\d,]*)\.\d{1,2}\b/g, "$1")
    .replace(/(\$\s?\d[\d,]*)\s*(?:\/\s*(?:yr|year)\b|per year\b|annually\b)/gi, "$1");
}

export interface BuildPostingInput {
  readonly card: LinkedInCard;
  readonly detail: LinkedInDetail;
  readonly remote: boolean;
  readonly sourceId: string;
  readonly fetchedAt: string;
}

/** Pure: card + detail -> the pipeline's RawPosting. Compensation and facts lead the body so the scorer sees them. */
export function buildPosting({ card, detail, remote, sourceId, fetchedAt }: BuildPostingInput): RawPosting {
  const title = detail.title || card.title;
  const company = detail.company || card.company;
  const stated = detail.location || card.location;
  // The search asked LinkedIn's own remote filter; the location classifier
  // reads "Remote" in the location field, qualified by the stated place so
  // the US-remote rule still sees a non-US country.
  const location = remote ? (stated ? `Remote (${stated})` : "Remote") : stated;

  const facts: string[] = [];
  if (detail.compensation) facts.push(`Compensation: ${detail.compensation}`);
  for (const [key, value] of detail.criteria) facts.push(`${key}: ${value}`);
  const head = facts.length > 0 ? `<p>${facts.map((line) => escapeHtml(line)).join("</p><p>")}</p>` : "";

  return {
    sourceId,
    // The page's own external apply link when it has one, else the job page
    // LinkedIn served — both taken from the page, neither constructed.
    url: detail.applyUrl ?? card.url,
    title,
    company,
    location,
    body: normalizeCompensationText(`${head}${detail.descriptionHtml}`),
    postedAt: detail.postedAt ?? (card.listDate ? `${card.listDate}T00:00:00.000Z` : null),
    applicantCount: detail.applicantCount,
    fetchedAt,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const BLOCKED_STATUSES = new Set([401, 403, 429, 999]);

/** True when a served page is a login wall, authwall or CAPTCHA rather than the content asked for. */
export function looksBlocked(finalUrl: string, body: string): boolean {
  if (/\/(authwall|login|checkpoint|uas\/login)\b/i.test(new URL(finalUrl, "https://www.linkedin.com").pathname)) return true;
  return /captcha|security verification|unusual activity/i.test(body.slice(0, 20_000)) && !/base-search-card|show-more-less-html/i.test(body);
}

export interface LinkedInGuestOptions {
  readonly plans?: readonly LinkedInSearchPlan[];
  readonly maxSearchRequests?: number;
  readonly maxDetailRequests?: number;
  /** Injected in tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injected in tests. Defaults to a real randomized wait between requests. */
  readonly pause?: () => Promise<void>;
  readonly now?: () => number;
  /** Called once if the run was cut short by throttling, a login wall or an error. */
  readonly onWarning?: (message: string) => void;
}

const realPause = async (): Promise<void> => {
  const delay = MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS);
  await new Promise((resolve) => setTimeout(resolve, delay));
};

export function createLinkedInGuestSource(options: LinkedInGuestOptions = {}): Source {
  const plans = options.plans ?? DEFAULT_SEARCH_PLANS;
  const maxSearch = options.maxSearchRequests ?? MAX_SEARCH_REQUESTS;
  const maxDetail = options.maxDetailRequests ?? MAX_DETAIL_REQUESTS;
  const doFetch = options.fetchImpl ?? fetch;
  const pause = options.pause ?? realPause;
  const nowMs = options.now ?? Date.now;

  /** One anonymous GET. No cookies, no auth header, no retry. */
  async function get(url: string): Promise<{ status: number; body: string } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await doFetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "text/html" },
        signal: controller.signal,
        credentials: "omit",
      });
      if (BLOCKED_STATUSES.has(response.status)) {
        throw new LinkedInBlockedError(`LinkedIn answered HTTP ${response.status} (throttled or blocked)`);
      }
      if (response.status === 404 || response.status === 410) return null;
      if (!response.ok) throw new Error(`LinkedIn answered HTTP ${response.status}`);
      const body = await response.text();
      if (looksBlocked(response.url || url, body)) {
        throw new LinkedInBlockedError("LinkedIn served a login wall or CAPTCHA instead of job data");
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: LINKEDIN_GUEST_SOURCE_ID,
    company: null,
    async fetch() {
      const fetchedAt = new Date(nowMs()).toISOString();
      const postings: RawPosting[] = [];
      let stopped: string | null = null;
      let requests = 0;

      // Stage 1: search cards, sequential, capped.
      const found = new Map<string, { card: LinkedInCard; remote: boolean }>();
      try {
        search: for (const plan of plans) {
          for (const start of plan.starts) {
            if (requests >= maxSearch) break search;
            if (requests > 0) await pause();
            requests += 1;
            const page = await get(linkedinSearchUrl(plan, start));
            if (!page) continue;
            const cards = parseSearchCards(page.body);
            for (const card of cards) {
              if (!found.has(card.jobId)) found.set(card.jobId, { card, remote: plan.remote });
            }
            // A short page is the last page; don't ask for the next one.
            if (cards.length < 10) break;
          }
        }
      } catch (error) {
        stopped = error instanceof Error ? error.message : String(error);
      }

      // Stage 2: details, newest cards first, only inside the age window and the cap.
      const wanted = [...found.values()]
        .filter(({ card }) => postedWithinDays(card.listDate, MAX_CARD_AGE_DAYS, nowMs()))
        .sort((a, b) => (b.card.listDate ?? "").localeCompare(a.card.listDate ?? ""))
        .slice(0, maxDetail);

      if (stopped === null) {
        try {
          for (const { card, remote } of wanted) {
            await pause();
            const page = await get(linkedinDetailUrl(card.jobId));
            if (!page) continue;
            const detail = parseJobDetail(page.body, nowMs());
            // A closed job or an unparseable page has no description to judge — skip it, don't guess.
            if (!detail || detail.closed) continue;
            postings.push(buildPosting({ card, detail, remote, sourceId: LINKEDIN_GUEST_SOURCE_ID, fetchedAt }));
          }
        } catch (error) {
          stopped = error instanceof Error ? error.message : String(error);
        }
      }

      if (stopped !== null) {
        options.onWarning?.(
          `LinkedIn guest source stopped early (${stopped}); kept ${postings.length} posting(s), no retry. The next scheduled run tries again.`,
        );
        // Nothing gathered: report as degraded so the digest says so.
        if (postings.length === 0) throw new Error(stopped);
      }
      return postings;
    },
  };
}
