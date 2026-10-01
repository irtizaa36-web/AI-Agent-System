import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  buildPosting,
  createLinkedInGuestSource,
  DEFAULT_SEARCH_PLANS,
  LINKEDIN_GUEST_BREAKER_FILE,
  LINKEDIN_GUEST_SOURCE_ID,
  linkedinDetailUrl,
  linkedinSearchUrl,
  looksBlocked,
  MAX_DETAIL_REQUESTS,
  MAX_SEARCH_REQUESTS,
  normalizeCompensationText,
  parseApplicantCount,
  parseApplyUrl,
  parseJobDetail,
  parseRelativeAge,
  parseSearchCards,
  type LinkedInSearchPlan,
} from "./linkedin-guest";
import { parseSalary } from "../normalize";
import { loadPreferences } from "../config";
import { runPipeline } from "../pipeline";
import { createPublicBoardSources } from "./public-boards";
import { InMemoryJobStore } from "../../store/job-store";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const GUEST_PREFIX = "https://www.linkedin.com/jobs-guest/jobs/api/";

// --- Fixtures, modeled on the markup the guest endpoints served on 2026-09-30 ---

function card(id: string, title: string, company: string, location: string, date: string, opts: { href?: string | null } = {}): string {
  const href =
    opts.href === undefined
      ? `https://www.linkedin.com/jobs/view/${title.toLowerCase().replace(/\W+/g, "-")}-at-acme-${id}?position=1&amp;pageNum=0&amp;refId=abc%3D%3D&amp;trackingId=xyz%3D%3D`
      : opts.href;
  return `
  <li>
    <div class="base-card relative base-search-card base-search-card--link job-search-card" data-entity-urn="urn:li:jobPosting:${id}">
      ${href === null ? "" : `<a class="base-card__full-link absolute" href="${href}" data-tracking-control-name="public_jobs_jserp-result_search-card"><span class="sr-only">${title}</span></a>`}
      <div class="base-search-card__info">
        <h3 class="base-search-card__title">
          ${title}
        </h3>
        <h4 class="base-search-card__subtitle">
          <a class="hidden-nested-link" href="https://www.linkedin.com/company/acme?trk=x">
            ${company}
          </a>
        </h4>
        <div class="base-search-card__metadata">
          <span class="job-search-card__location">
            ${location}
          </span>
          <time class="job-search-card__listdate--new" datetime="${date}">
            5 hours ago
          </time>
        </div>
      </div>
    </div>
  </li>`;
}

function searchPage(cards: readonly string[]): string {
  return `<!DOCTYPE html>\n${cards.join("\n")}`;
}

interface DetailOptions {
  title?: string;
  company?: string;
  location?: string;
  age?: string;
  applicants?: string;
  description?: string;
  compensation?: string;
  applyUrlComment?: string;
  extra?: string;
}

function detailPage(o: DetailOptions = {}): string {
  return `<section class="top-card-layout">
    <h2 class="top-card-layout__title font-sans topcard__title">${o.title ?? "Marketing Program Manager"}</h2>
    <h4 class="top-card-layout__second-subline">
      <div class="topcard__flavor-row">
        <span class="topcard__flavor">
          <a class="topcard__org-name-link topcard__flavor--black-link" href="https://www.linkedin.com/company/acme?trk=x" rel="noopener">
            ${o.company ?? "Acme"}
          </a>
        </span>
        <span class="topcard__flavor topcard__flavor--bullet">
          ${o.location ?? "United States"}
        </span>
      </div>
      <div class="topcard__flavor-row">
        <span class="posted-time-ago__text posted-time-ago__text--new topcard__flavor--metadata">
          ${o.age ?? "5 hours ago"}
        </span>
        <span class="num-applicants__caption topcard__flavor--metadata topcard__flavor--bullet">
          ${o.applicants ?? "59 applicants"}
        </span>
      </div>
    </h4>
    ${o.compensation ? `<div class="salary compensation__salary">${o.compensation}</div>` : ""}
    ${o.applyUrlComment ? `<code id="applyUrl" style="display: none"><!--"${o.applyUrlComment}"--></code>` : ""}
  </section>
  <div class="description__text description__text--rich">
    <section class="show-more-less-html" data-max-lines="5">
      <div class="show-more-less-html__markup show-more-less-html__markup--clamp-after-5 relative">${o.description ?? "Own integrated campaigns. 3-5 years of program management experience.<br><br>Great team."}</div>
    </section>
  </div>
  <ul class="description__job-criteria-list">
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader">Seniority level</h3>
      <span class="description__job-criteria-text description__job-criteria-text--criteria">Mid-Senior level</span>
    </li>
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader">Job function</h3>
      <span class="description__job-criteria-text description__job-criteria-text--criteria">Marketing</span>
    </li>
  </ul>
  ${o.extra ?? ""}`;
}

// --- Pure parsing ---

describe("linkedin guest URL builders", () => {
  it("builds anonymous jobs-guest search URLs with the past-week window and the remote filter", () => {
    const url = new URL(linkedinSearchUrl({ keywords: "Marketing Program Manager", location: "United States", remote: true }, 10));
    assert.equal(url.origin + url.pathname, `${GUEST_PREFIX}seeMoreJobPostings/search`);
    assert.equal(url.searchParams.get("keywords"), "Marketing Program Manager");
    assert.equal(url.searchParams.get("location"), "United States");
    assert.equal(url.searchParams.get("f_TPR"), "r604800");
    assert.equal(url.searchParams.get("f_WT"), "2");
    assert.equal(url.searchParams.get("start"), "10");
  });

  it("omits the remote filter for metro searches", () => {
    const url = new URL(linkedinSearchUrl({ keywords: "Marketing Program Manager", location: "Houston, TX", remote: false }, 0));
    assert.equal(url.searchParams.has("f_WT"), false);
  });

  it("builds the detail URL from a numeric job id", () => {
    assert.equal(linkedinDetailUrl("4472216175"), `${GUEST_PREFIX}jobPosting/4472216175`);
  });

  it("the default plans cover US-remote plus Houston, Dallas and New York only", () => {
    const places = new Set(DEFAULT_SEARCH_PLANS.map((p) => (p.remote ? "remote" : p.location)));
    assert.deepEqual([...places].sort(), ["Dallas, TX", "Houston, TX", "New York, NY", "remote"]);
    const searches = DEFAULT_SEARCH_PLANS.reduce((sum, p) => sum + p.starts.length, 0);
    assert.ok(searches <= MAX_SEARCH_REQUESTS, "default plans fit inside the per-run search cap");
  });
});

describe("parseSearchCards", () => {
  it("extracts title, company, location, date and a tracking-free job-view URL", () => {
    const [first] = parseSearchCards(searchPage([card("4472216175", "Marketing Program Manager, Americas", "MiniMed", "Los Angeles, CA", "2026-09-29")]));
    assert.ok(first);
    assert.equal(first.jobId, "4472216175");
    assert.equal(first.title, "Marketing Program Manager, Americas");
    assert.equal(first.company, "MiniMed");
    assert.equal(first.location, "Los Angeles, CA");
    assert.equal(first.listDate, "2026-09-29");
    assert.equal(first.url, "https://www.linkedin.com/jobs/view/marketing-program-manager-americas-at-acme-4472216175");
  });

  it("skips a card with no job-view link instead of inventing one", () => {
    const cards = parseSearchCards(
      searchPage([card("1", "No Link", "Acme", "Remote", "2026-09-29", { href: null }), card("2", "Has Link", "Acme", "Remote", "2026-09-29")]),
    );
    assert.deepEqual(cards.map((c) => c.jobId), ["2"]);
  });

  it("rejects links that are not linkedin.com job-view pages", () => {
    const cards = parseSearchCards(
      searchPage([
        card("1", "Off Site", "Acme", "Remote", "2026-09-29", { href: "https://evil.example/jobs/view/x-1" }),
        card("2", "Wrong Path", "Acme", "Remote", "2026-09-29", { href: "https://www.linkedin.com/login?x=1" }),
      ]),
    );
    assert.deepEqual(cards, []);
  });

  it("returns nothing for an empty or unrelated page", () => {
    assert.deepEqual(parseSearchCards(""), []);
    assert.deepEqual(parseSearchCards("<html><body>nothing here</body></html>"), []);
  });
});

describe("parseRelativeAge", () => {
  it("converts relative ages to timestamps", () => {
    assert.equal(parseRelativeAge("5 hours ago", NOW), "2026-09-30T07:00:00.000Z");
    assert.equal(parseRelativeAge("1 day ago", NOW), "2026-09-29T12:00:00.000Z");
    assert.equal(parseRelativeAge("3 days ago", NOW), "2026-09-27T12:00:00.000Z");
    assert.equal(parseRelativeAge("2 weeks ago", NOW), "2026-09-16T12:00:00.000Z");
    assert.equal(parseRelativeAge("30 minutes ago", NOW), "2026-09-30T11:30:00.000Z");
    assert.equal(parseRelativeAge("Reposted 2 days ago", NOW), "2026-09-28T12:00:00.000Z");
  });

  it("returns null for anything it cannot read — never a guess", () => {
    assert.equal(parseRelativeAge("", NOW), null);
    assert.equal(parseRelativeAge("recently", NOW), null);
  });
});

describe("parseApplicantCount", () => {
  it("reads the count variants LinkedIn shows", () => {
    assert.equal(parseApplicantCount("59 applicants"), 59);
    assert.equal(parseApplicantCount("1 applicant"), 1);
    assert.equal(parseApplicantCount("Over 200 applicants"), 200);
    assert.equal(parseApplicantCount("Be among the first 25 applicants"), 25);
    assert.equal(parseApplicantCount("1,250 applicants"), 1250);
  });

  it("returns null (unknown), never zero, when the page states none", () => {
    assert.equal(parseApplicantCount(""), null);
    assert.equal(parseApplicantCount("Be an early applicant"), null);
  });
});

describe("parseApplyUrl", () => {
  it("returns a plain off-site apply URL from the page", () => {
    assert.equal(parseApplyUrl(`<code id="applyUrl" style="display: none"><!--"https://boards.greenhouse.io/acme/jobs/123"--></code>`), "https://boards.greenhouse.io/acme/jobs/123");
  });

  it("unwraps LinkedIn's externalApply redirect to the real employer URL", () => {
    const wrapped = "https://www.linkedin.com/jobs/view/externalApply/123?url=https%3A%2F%2Fjobs.lever.co%2Facme%2Fabc&amp;urlHash=zz";
    assert.equal(parseApplyUrl(`<code id="applyUrl"><!--"${wrapped}"--></code>`), "https://jobs.lever.co/acme/abc");
  });

  it("returns null when the page exposes no apply URL, or only a linkedin link with no target", () => {
    assert.equal(parseApplyUrl("<html></html>"), null);
    assert.equal(parseApplyUrl(`<code id="applyUrl"><!--"https://www.linkedin.com/jobs/view/externalApply/123"--></code>`), null);
    assert.equal(parseApplyUrl(`<code id="applyUrl"><!--"javascript:alert(1)"--></code>`), null);
  });
});

describe("parseJobDetail", () => {
  it("extracts title, company, location, age, applicants, description and criteria", () => {
    const detail = parseJobDetail(detailPage({ age: "2 days ago", applicants: "Over 200 applicants" }), NOW);
    assert.ok(detail);
    assert.equal(detail.title, "Marketing Program Manager");
    assert.equal(detail.company, "Acme");
    assert.equal(detail.location, "United States");
    assert.equal(detail.postedAt, "2026-09-28T12:00:00.000Z");
    assert.equal(detail.applicantCount, 200);
    assert.match(detail.descriptionHtml, /3-5 years of program management experience/);
    assert.deepEqual(detail.criteria, [
      ["Seniority level", "Mid-Senior level"],
      ["Job function", "Marketing"],
    ]);
    assert.equal(detail.compensation, null);
    assert.equal(detail.applyUrl, null);
    assert.equal(detail.closed, false);
  });

  it("captures a compensation block when the page has one", () => {
    const detail = parseJobDetail(detailPage({ compensation: "$130,000.00/yr - $160,000.00/yr" }), NOW);
    assert.equal(detail?.compensation, "$130,000.00/yr - $160,000.00/yr");
  });

  it("flags a closed posting", () => {
    const detail = parseJobDetail(detailPage({ extra: `<figcaption class="closed-job__flavor">No longer accepting applications</figcaption>` }), NOW);
    assert.equal(detail?.closed, true);
  });

  it("returns null for a page that is not a job page", () => {
    assert.equal(parseJobDetail("<html><body>Sign in to LinkedIn</body></html>", NOW), null);
  });
});

describe("compensation reaches the existing salary parser", () => {
  it("rewrites LinkedIn's cents and /yr suffix so parseSalary can read the range", () => {
    assert.deepEqual(parseSalary(normalizeCompensationText("Salary ranges (USD):$109,000.00-$185,000.00")), {
      min: 109000,
      max: 185000,
      currency: "USD",
    });
    assert.deepEqual(parseSalary(normalizeCompensationText("$130,000.00/yr - $160,000.00/yr")), {
      min: 130000,
      max: 160000,
      currency: "USD",
    });
  });

  it("leaves hourly figures alone so they stay unparsed", () => {
    assert.equal(normalizeCompensationText("$45.50/hr"), "$45/hr");
    assert.deepEqual(parseSalary(normalizeCompensationText("$45.50/hr - $60.00/hr")), { min: null, max: null, currency: null });
  });
});

describe("buildPosting", () => {
  const cardFor = (location = "Los Angeles, CA") => ({
    jobId: "9",
    title: "Card Title",
    company: "Card Co",
    location,
    url: "https://www.linkedin.com/jobs/view/card-title-at-card-co-9",
    listDate: "2026-09-29",
  });
  const detail = parseJobDetail(detailPage({ compensation: "$130,000.00/yr - $160,000.00/yr" }), NOW);

  it("marks results from the remote search as Remote, qualified by the stated place", () => {
    assert.ok(detail);
    const posting = buildPosting({ card: cardFor(), detail, remote: true, sourceId: LINKEDIN_GUEST_SOURCE_ID, fetchedAt: "t" });
    assert.equal(posting.location, "Remote (United States)");
    assert.equal(posting.sourceId, "linkedin:guest");
  });

  it("keeps the stated city for metro searches", () => {
    assert.ok(detail);
    const posting = buildPosting({ card: cardFor(), detail: { ...detail, location: "Houston, TX" }, remote: false, sourceId: "s", fetchedAt: "t" });
    assert.equal(posting.location, "Houston, TX");
  });

  it("uses the job page URL from the card when the page exposes no external apply link", () => {
    assert.ok(detail);
    const posting = buildPosting({ card: cardFor(), detail, remote: true, sourceId: "s", fetchedAt: "t" });
    assert.equal(posting.url, "https://www.linkedin.com/jobs/view/card-title-at-card-co-9");
  });

  it("prefers the external apply URL the page itself exposes", () => {
    assert.ok(detail);
    const posting = buildPosting({ card: cardFor(), detail: { ...detail, applyUrl: "https://jobs.lever.co/acme/abc" }, remote: true, sourceId: "s", fetchedAt: "t" });
    assert.equal(posting.url, "https://jobs.lever.co/acme/abc");
  });

  it("puts compensation first in the body and carries applicants and age through", () => {
    assert.ok(detail);
    const posting = buildPosting({ card: cardFor(), detail, remote: true, sourceId: "s", fetchedAt: "t" });
    assert.match(posting.body, /^<p>Compensation: \$130,000 - \$160,000<\/p>/);
    assert.deepEqual(parseSalary(posting.body), { min: 130000, max: 160000, currency: "USD" });
    assert.equal(posting.applicantCount, 59);
    assert.equal(posting.postedAt, "2026-09-30T07:00:00.000Z");
  });

  it("falls back to the card's date when the page states no relative age", () => {
    const noAge = parseJobDetail(detailPage({ age: "" }), NOW);
    assert.ok(noAge);
    const posting = buildPosting({ card: cardFor(), detail: noAge, remote: true, sourceId: "s", fetchedAt: "t" });
    assert.equal(posting.postedAt, "2026-09-29T00:00:00.000Z");
  });
});

describe("looksBlocked", () => {
  it("detects authwall, login and checkpoint redirects and CAPTCHA pages", () => {
    assert.equal(looksBlocked("https://www.linkedin.com/authwall?trk=x", "<html></html>"), true);
    assert.equal(looksBlocked("https://www.linkedin.com/login", "<html></html>"), true);
    assert.equal(looksBlocked("https://www.linkedin.com/checkpoint/challenge", "<html></html>"), true);
    assert.equal(looksBlocked(`${GUEST_PREFIX}jobPosting/1`, "<html>Please complete the CAPTCHA</html>"), true);
  });

  it("does not flag a normal results page that happens to mention login links", () => {
    assert.equal(looksBlocked(`${GUEST_PREFIX}jobPosting/1`, detailPage()), false);
  });
});

// --- The source: politeness and guest-only guarantees ---

interface Recorded {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly init: RequestInit;
}

function fakeFetch(
  handler: (url: string, callNumber: number) => { status?: number; body?: string; finalUrl?: string },
): { impl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) }, init: init ?? {} });
    const { status = 200, body = "", finalUrl } = handler(url, calls.length);
    // Response cannot represent LinkedIn's non-standard 999.
    const response =
      status > 599 ? ({ status, ok: false, url: "", text: async () => body } as unknown as Response) : new Response(body, { status });
    if (finalUrl) Object.defineProperty(response, "url", { value: finalUrl });
    return response;
  }) as typeof fetch;
  return { impl, calls };
}

const onePlan: readonly LinkedInSearchPlan[] = [{ keywords: "Marketing Program Manager", location: "United States", remote: true, starts: [0] }];

function sourceWith(
  impl: typeof fetch,
  extra: Partial<Parameters<typeof createLinkedInGuestSource>[0]> = {},
): { source: ReturnType<typeof createLinkedInGuestSource>; pauses: number[]; warnings: string[] } {
  const pauses: number[] = [];
  const warnings: string[] = [];
  const source = createLinkedInGuestSource({
    plans: onePlan,
    fetchImpl: impl,
    pause: async () => {
      pauses.push(1);
    },
    now: () => NOW,
    onWarning: (m) => warnings.push(m),
    ...extra,
  });
  return { source, pauses, warnings };
}

const tenCards = (prefix: number): string[] =>
  Array.from({ length: 10 }, (_, i) => card(String(prefix + i), `Marketing Program Manager ${i}`, "Acme", "United States", "2026-09-29"));

describe("createLinkedInGuestSource", () => {
  it("fetches search cards then details and emits RawPostings with every requested field", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.includes("seeMoreJobPostings")) return { body: searchPage([card("11", "Marketing Program Manager", "Acme", "United States", "2026-09-29")]) };
      return { body: detailPage({ compensation: "$130,000.00/yr - $160,000.00/yr", applicants: "59 applicants", age: "5 hours ago" }) };
    });
    const { source } = sourceWith(impl);
    const postings = await source.fetch();

    assert.equal(postings.length, 1);
    const [p] = postings;
    assert.equal(p?.title, "Marketing Program Manager");
    assert.equal(p?.company, "Acme");
    assert.equal(p?.location, "Remote (United States)");
    assert.equal(p?.applicantCount, 59);
    assert.equal(p?.postedAt, "2026-09-30T07:00:00.000Z");
    assert.match(p?.body ?? "", /3-5 years of program management experience/);
    assert.deepEqual(parseSalary(p?.body ?? ""), { min: 130000, max: 160000, currency: "USD" });
    assert.match(p?.url ?? "", /^https:\/\/www\.linkedin\.com\/jobs\/view\//);
    assert.equal(calls.length, 2);
  });

  it("is guest-only: only jobs-guest URLs, no cookies, no auth headers, credentials omitted, honest user agent", async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.includes("seeMoreJobPostings") ? { body: searchPage([card("11", "Marketing Program Manager", "Acme", "United States", "2026-09-29")]) } : { body: detailPage() },
    );
    await sourceWith(impl).source.fetch();
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.ok(call.url.startsWith(GUEST_PREFIX), `unexpected URL ${call.url}`);
      const names = Object.keys(call.headers).map((h) => h.toLowerCase());
      assert.ok(!names.includes("cookie") && !names.includes("authorization"), "no credentials of any kind");
      assert.equal(call.init.credentials, "omit");
      assert.match(call.headers["user-agent"] ?? "", /^MobyAI-JobSearch\//);
    }
  });

  it("paces requests sequentially — one pause before every request after the first", async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.includes("seeMoreJobPostings")
        ? { body: searchPage([card("11", "A", "Acme", "United States", "2026-09-29"), card("12", "B", "Acme", "United States", "2026-09-29")]) }
        : { body: detailPage() },
    );
    const { source, pauses } = sourceWith(impl);
    await source.fetch();
    assert.equal(calls.length, 3);
    assert.equal(pauses.length, 2);
  });

  it("dedupes a job found by several searches and fetches its detail once", async () => {
    const plans: LinkedInSearchPlan[] = [
      { keywords: "Marketing Program Manager", location: "United States", remote: true, starts: [0] },
      { keywords: "Product Marketing Manager", location: "United States", remote: true, starts: [0] },
    ];
    const { impl, calls } = fakeFetch((url) =>
      url.includes("seeMoreJobPostings") ? { body: searchPage([card("11", "Marketing Program Manager", "Acme", "United States", "2026-09-29")]) } : { body: detailPage() },
    );
    const postings = await sourceWith(impl, { plans }).source.fetch();
    assert.equal(postings.length, 1);
    assert.equal(calls.filter((c) => c.url.includes("/jobPosting/")).length, 1);
  });

  it("never spends a detail request on a card older than a week", async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.includes("seeMoreJobPostings")
        ? { body: searchPage([card("11", "Fresh", "Acme", "United States", "2026-09-29"), card("12", "Stale", "Acme", "United States", "2026-09-10")]) }
        : { body: detailPage() },
    );
    await sourceWith(impl).source.fetch();
    const detailCalls = calls.filter((c) => c.url.includes("/jobPosting/"));
    assert.deepEqual(detailCalls.map((c) => c.url), [linkedinDetailUrl("11")]);
  });

  it("enforces the per-run search and detail caps", async () => {
    const plans: LinkedInSearchPlan[] = Array.from({ length: 20 }, (_, i) => ({
      keywords: `Marketing ${i}`,
      location: "United States",
      remote: true,
      starts: [0, 10],
    }));
    let page = 0;
    const { impl, calls } = fakeFetch((url) => {
      if (url.includes("seeMoreJobPostings")) {
        page += 1;
        return { body: searchPage(tenCards(page * 100)) };
      }
      return { body: detailPage() };
    });
    const postings = await sourceWith(impl, { plans }).source.fetch();
    assert.equal(calls.filter((c) => c.url.includes("seeMoreJobPostings")).length, MAX_SEARCH_REQUESTS);
    assert.equal(calls.filter((c) => c.url.includes("/jobPosting/")).length, MAX_DETAIL_REQUESTS);
    assert.equal(postings.length, MAX_DETAIL_REQUESTS);
  });

  it("stops asking for further pages once a page comes back short", async () => {
    const plans: LinkedInSearchPlan[] = [{ keywords: "x", location: "United States", remote: true, starts: [0, 10, 20] }];
    const { impl, calls } = fakeFetch((url) =>
      url.includes("seeMoreJobPostings") ? { body: searchPage([card("11", "A", "Acme", "United States", "2026-09-29")]) } : { body: detailPage() },
    );
    await sourceWith(impl, { plans }).source.fetch();
    assert.equal(calls.filter((c) => c.url.includes("seeMoreJobPostings")).length, 1);
  });

  it("backs off on HTTP 429 during search: one request, no retry, reported as degraded", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 429 }));
    const { source, warnings } = sourceWith(impl);
    await assert.rejects(() => source.fetch(), /HTTP 429/);
    assert.equal(calls.length, 1, "a throttle response is never retried");
    assert.equal(warnings.length, 1);
  });

  it("treats LinkedIn's 999 status as a block", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 999 }));
    await assert.rejects(() => sourceWith(impl).source.fetch(), /HTTP 999/);
    assert.equal(calls.length, 1);
  });

  it("treats an authwall redirect as a block and does not work around it", async () => {
    const { impl, calls } = fakeFetch(() => ({ body: "<html>Sign in</html>", finalUrl: "https://www.linkedin.com/authwall?trk=x" }));
    await assert.rejects(() => sourceWith(impl).source.fetch(), /login wall or CAPTCHA/);
    assert.equal(calls.length, 1);
    assert.ok(calls.every((c) => c.url.startsWith(GUEST_PREFIX)));
  });

  it("keeps what it has and stops immediately when throttled mid-run", async () => {
    let detailCalls = 0;
    const { impl, calls } = fakeFetch((url) => {
      if (url.includes("seeMoreJobPostings")) {
        return { body: searchPage([card("11", "A", "Acme", "United States", "2026-09-29"), card("12", "B", "Acme", "United States", "2026-09-29"), card("13", "C", "Acme", "United States", "2026-09-29")]) };
      }
      detailCalls += 1;
      return detailCalls === 1 ? { body: detailPage() } : { status: 429 };
    });
    const { source, warnings } = sourceWith(impl);
    const postings = await source.fetch();
    assert.equal(postings.length, 1, "the posting gathered before the throttle is kept");
    assert.equal(calls.length, 3, "search + 1 good detail + the 429; nothing after");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /no retry/);
  });

  it("skips a removed job (404) and a closed job without stopping the run", async () => {
    const { impl } = fakeFetch((url) => {
      if (url.includes("seeMoreJobPostings")) {
        return { body: searchPage([card("11", "Gone", "Acme", "United States", "2026-09-29"), card("12", "Closed", "Acme", "United States", "2026-09-29"), card("13", "Open", "Acme", "United States", "2026-09-29")]) };
      }
      if (url.endsWith("/11")) return { status: 404 };
      if (url.endsWith("/12")) return { body: detailPage({ extra: "No longer accepting applications" }) };
      return { body: detailPage({ title: "Open" }) };
    });
    const postings = await sourceWith(impl).source.fetch();
    assert.deepEqual(postings.map((p) => p.title), ["Open"]);
  });

  it("returns an empty list, not an error, when the search simply finds nothing", async () => {
    const { impl } = fakeFetch(() => ({ body: "<!DOCTYPE html>" }));
    assert.deepEqual(await sourceWith(impl).source.fetch(), []);
  });

  it("has no timer or schedule of its own: constructing it makes no request", () => {
    const { impl, calls } = fakeFetch(() => ({ body: "" }));
    sourceWith(impl);
    assert.equal(calls.length, 0);
  });
});

// --- Persistent circuit breaker ---

describe("circuit breaker", () => {
  async function withBreaker(run: (breakerPath: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "linkedin-breaker-"));
    try {
      await run(join(dir, "nested", LINKEDIN_GUEST_BREAKER_FILE));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

  const blocks: readonly (readonly [string, Parameters<typeof fakeFetch>[0], RegExp])[] = [
    ["HTTP 429", () => ({ status: 429 }), /HTTP 429/],
    ["HTTP 999", () => ({ status: 999 }), /HTTP 999/],
    ["HTTP 403", () => ({ status: 403 }), /HTTP 403/],
    ["an authwall redirect", () => ({ body: "<html>Sign in</html>", finalUrl: "https://www.linkedin.com/authwall?trk=x" }), /login wall or CAPTCHA/],
  ];

  for (const [label, respond, cause] of blocks) {
    it(`trips on ${label}: writes the flag, names the cause, and the next run makes no request`, async () => {
      await withBreaker(async (breakerPath) => {
        const first = fakeFetch(respond);
        const a = sourceWith(first.impl, { breakerPath });
        await assert.rejects(() => a.source.fetch(), cause);
        assert.equal(first.calls.length, 1);
        assert.ok(a.warnings.some((w) => /DISABLED for all later runs/.test(w) && cause.test(w)), a.warnings.join("\n"));

        const saved = JSON.parse(await readFile(breakerPath, "utf8")) as { disabledAt: string; cause: string };
        assert.match(saved.cause, cause);
        assert.equal(saved.disabledAt, new Date(NOW).toISOString());

        // A brand-new source instance (a later scheduled run) must stay off.
        const second = fakeFetch(() => ({ body: searchPage([card("11", "A", "Acme", "United States", "2026-09-29")]) }));
        const b = sourceWith(second.impl, { breakerPath });
        assert.deepEqual(await b.source.fetch(), []);
        assert.equal(second.calls.length, 0, "a tripped breaker means zero requests");
        assert.equal(b.warnings.length, 1);
        assert.match(b.warnings[0] ?? "", /DISABLED/);
        assert.match(b.warnings[0] ?? "", cause);
        assert.ok((b.warnings[0] ?? "").includes(breakerPath), "tells the owner which file to delete");
      });
    });
  }

  it("trips when the block arrives mid-run, and keeps the postings gathered before it", async () => {
    await withBreaker(async (breakerPath) => {
      let detailCalls = 0;
      const { impl } = fakeFetch((url) => {
        if (url.includes("seeMoreJobPostings")) {
          return { body: searchPage([card("11", "A", "Acme", "United States", "2026-09-29"), card("12", "B", "Acme", "United States", "2026-09-29")]) };
        }
        detailCalls += 1;
        return detailCalls === 1 ? { body: detailPage() } : { status: 429 };
      });
      const postings = await sourceWith(impl, { breakerPath }).source.fetch();
      assert.equal(postings.length, 1);
      assert.ok(await exists(breakerPath));
    });
  });

  it("re-enables only when the flag file is deleted by a person", async () => {
    await withBreaker(async (breakerPath) => {
      await assert.rejects(() => sourceWith(fakeFetch(() => ({ status: 429 })).impl, { breakerPath }).source.fetch());
      await rm(breakerPath);
      const { impl, calls } = fakeFetch((url) =>
        url.includes("seeMoreJobPostings") ? { body: searchPage([card("11", "A", "Acme", "United States", "2026-09-29")]) } : { body: detailPage() },
      );
      const postings = await sourceWith(impl, { breakerPath }).source.fetch();
      assert.equal(postings.length, 1);
      assert.equal(calls.length, 2);
    });
  });

  it("does not trip on an ordinary failure (HTTP 500) or on a 404", async () => {
    await withBreaker(async (breakerPath) => {
      await assert.rejects(() => sourceWith(fakeFetch(() => ({ status: 500 })).impl, { breakerPath }).source.fetch(), /HTTP 500/);
      assert.equal(await exists(breakerPath), false);
    });
  });

  it("fails closed when the flag file is unreadable as JSON", async () => {
    await withBreaker(async (breakerPath) => {
      await sourceWith(fakeFetch(() => ({ status: 429 })).impl, { breakerPath }).source.fetch().catch(() => undefined);
      await writeFile(breakerPath, "not json", "utf8");
      const { impl, calls } = fakeFetch(() => ({ body: "<!DOCTYPE html>" }));
      assert.deepEqual(await sourceWith(impl, { breakerPath }).source.fetch(), []);
      assert.equal(calls.length, 0);
    });
  });

  it("is wired by createPublicBoardSources into the profile's data directory", async () => {
    const boards = createPublicBoardSources("shivani", [], { root: "/tmp/never-written" });
    assert.ok(boards.sources.some((s) => s.id === LINKEDIN_GUEST_SOURCE_ID));
  });
});

// --- Filter / pipeline integration with Shivani's real preferences ---

describe("pipeline integration with Shivani's real filters", () => {
  it("reuses the existing filters: 6+ years, low pay, stale, non-US and out-of-metro roles are dropped; a fresh 3-5 year US-remote role survives", async () => {
    const prefs = await loadPreferences("shivani", process.cwd());
    const fetchedNow = Date.now();
    const iso = (hoursAgo: number): string => new Date(fetchedNow - hoursAgo * 3_600_000).toISOString();
    const dateOf = (hoursAgo: number): string => iso(hoursAgo).slice(0, 10);

    interface Role {
      id: string;
      title: string;
      company: string;
      location: string;
      hoursAgo: number;
      description: string;
      compensation?: string;
      applicants?: string;
      remote?: boolean;
    }
    const roles: Role[] = [
      { id: "1", title: "Marketing Program Manager", company: "GoodCo", location: "United States", hoursAgo: 5, description: "Drive integrated campaigns. 3-5 years of experience.", compensation: "$130,000.00/yr - $170,000.00/yr", applicants: "59 applicants" },
      { id: "2", title: "Marketing Program Manager", company: "SeniorCo", location: "United States", hoursAgo: 5, description: "8+ years of experience running programs." },
      { id: "3", title: "Marketing Program Manager", company: "SixCo", location: "United States", hoursAgo: 5, description: "Minimum 6 years of program management experience." },
      { id: "4", title: "Marketing Program Manager", company: "LowPayCo", location: "United States", hoursAgo: 5, description: "3-5 years of experience.", compensation: "$80,000.00/yr - $100,000.00/yr" },
      { id: "5", title: "Marketing Program Manager", company: "StaleCo", location: "United States", hoursAgo: 24 * 6, description: "3-5 years of experience." },
      { id: "6", title: "Marketing Program Manager", company: "AbroadCo", location: "Toronto, Ontario, Canada", hoursAgo: 5, description: "3-5 years of experience." },
      { id: "7", title: "Marketing Program Manager", company: "HoustonCo", location: "Houston, TX", hoursAgo: 5, description: "3-5 years of experience.", remote: false },
      { id: "8", title: "Marketing Program Manager", company: "ChicagoCo", location: "Chicago, IL", hoursAgo: 5, description: "3-5 years of experience.", remote: false },
      { id: "9", title: "Marketing Program Manager", company: "NoAppsCo", location: "United States", hoursAgo: 5, description: "No stated requirements.", applicants: "Be an early applicant" },
    ];
    const byId = new Map(roles.map((r) => [r.id, r]));

    const plans: LinkedInSearchPlan[] = [
      { keywords: "remote", location: "United States", remote: true, starts: [0] },
      { keywords: "metro", location: "Houston, TX", remote: false, starts: [0] },
    ];
    const { impl } = fakeFetch((url) => {
      if (url.includes("seeMoreJobPostings")) {
        const wantRemote = url.includes("f_WT=2");
        return {
          body: searchPage(
            roles
              .filter((r) => (r.remote ?? true) === wantRemote)
              .map((r) => card(r.id, r.title, r.company, r.location, dateOf(r.hoursAgo))),
          ),
        };
      }
      const role = byId.get(url.split("/").pop() ?? "") as Role;
      return {
        body: detailPage({
          title: role.title,
          company: role.company,
          location: role.location,
          age: role.hoursAgo >= 24 ? `${Math.floor(role.hoursAgo / 24)} days ago` : `${role.hoursAgo} hours ago`,
          applicants: role.applicants ?? "12 applicants",
          description: role.description,
          compensation: role.compensation,
        }),
      };
    });

    const source = createLinkedInGuestSource({ plans, fetchImpl: impl, pause: async () => {}, now: () => fetchedNow });
    const store = new InMemoryJobStore();
    const summary = await runPipeline({
      sources: [source],
      store,
      prefs,
      profile: { resume: "Marketing Program Manager at AWS.", notes: "" },
      costLogPath: join(tmpdir(), `linkedin-guest-costs-${process.pid}.jsonl`),
      politeDelay: false,
    });

    assert.equal(summary.fetchedCount, 9);
    const jobs = await store.listJobs();
    const stateOf = (company: string) => jobs.find((j) => j.company === company);

    const survivors = jobs.filter((j) => j.state !== "filtered").map((j) => j.company).sort();
    assert.deepEqual(survivors, ["GoodCo", "HoustonCo", "NoAppsCo"]);

    assert.match(stateOf("SeniorCo")?.filterReason ?? "", /8\+ years/);
    assert.match(stateOf("SixCo")?.filterReason ?? "", /6\+ years/);
    assert.match(stateOf("LowPayCo")?.filterReason ?? "", /below the 120,000 floor/);
    assert.match(stateOf("StaleCo")?.filterReason ?? "", /older than the 3-day limit/);
    assert.match(stateOf("AbroadCo")?.filterReason ?? "", /not eligible from the US/);
    assert.match(stateOf("ChicagoCo")?.filterReason ?? "", /Not remote/);

    const good = stateOf("GoodCo");
    assert.equal(good?.salaryMin, 130000);
    assert.equal(good?.applicantCount, 59);
    assert.equal(good?.locationClass, "remote");
    assert.match(good?.applyUrl ?? "", /^https:\/\/www\.linkedin\.com\/jobs\/view\//);
    assert.equal(stateOf("HoustonCo")?.locationClass, "onsite");
    assert.equal(stateOf("NoAppsCo")?.applicantCount, null, "an unstated applicant count stays unknown, never zero");
  });
});
