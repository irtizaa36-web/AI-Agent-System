import { test } from "node:test";
import assert from "node:assert/strict";
import { SettlementTracker } from "../tracker";
import { InMemoryTrackerStorage } from "../storage";
import { seedDocument } from "../seed";
import { CLASSACTION_ORG_PAGE, TOP_CLASS_ACTIONS_FEED } from "./fixtures";
import { classActionOrgSource, decodeEntities, readSource, topClassActionsSource, type FetchLike } from "./sources";
import { clusterListings, runResearchSweep } from "./pipeline";

const TODAY = "2026-09-25";

/** Serves the captured pages; `fail` makes a source unreachable, `pages` overrides one. */
function fakeFetch(opts: { fail?: string; pages?: Record<string, string> } = {}): FetchLike & { calls: string[] } {
  const pages: Record<string, string> = { [topClassActionsSource.url]: TOP_CLASS_ACTIONS_FEED, [classActionOrgSource.url]: CLASSACTION_ORG_PAGE, ...opts.pages };
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    if (url === opts.fail) throw new Error("getaddrinfo ENOTFOUND");
    const body = pages[url];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? "" };
  };
  return Object.assign(fn, { calls });
}

async function seededTracker() {
  return SettlementTracker.open(new InMemoryTrackerStorage(), { today: () => TODAY, seed: seedDocument });
}

test("Top Class Actions feed: fact-box fields parse from the real markup", () => {
  const listings = topClassActionsSource.parse(TOP_CLASS_ACTIONS_FEED);
  assert.equal(listings.length, 5);
  const vsl = listings.find((l) => l.title.startsWith("VSL"))!;
  assert.equal(vsl.title, "VSL Pharmaceuticals probiotic");
  assert.equal(vsl.deadline, "2026-10-20");
  assert.equal(vsl.payoutText, "Up to $800");
  assert.equal(vsl.website, "VSL3Lawsuit.com");
  assert.equal(vsl.claimUrl, "https://www.vsl3lawsuit.com/submit-claim");
  assert.match(vsl.eligibilityText!, /purchased VSL#3 in the United States between June 1, 2016, and June 19, 2019/);
  assert.equal(vsl.proofRequired, true);
  // An article without a fact box still lists, with nothing invented.
  const [bare] = topClassActionsSource.parse("<item><title>$5M Example Co. data breach class action settlement</title><link>https://example.test/a</link><content:encoded><![CDATA[<p>Story only.</p>]]></content:encoded></item>");
  assert.equal(bare!.title, "Example Co. data breach");
  assert.equal(bare!.deadline, undefined);
  assert.equal(bare!.payoutText, undefined);
  assert.equal(bare!.website, undefined);
});

test("ClassAction.org page: cards parse from the real markup", () => {
  const listings = classActionOrgSource.parse(CLASSACTION_ORG_PAGE);
  assert.equal(listings.length, 7);
  const atm = listings.find((l) => l.title === "Non-Bank ATM Surcharges")!;
  assert.equal(atm.deadline, "2027-02-27");
  assert.equal(atm.payoutText, "Varies");
  assert.equal(atm.proofRequired, false);
  const usa = listings.find((l) => l.title.startsWith("USA Clinics"))!;
  assert.equal(usa.payoutText, "$50 - $150");
  assert.equal(usa.deadline, "2026-10-05");
  assert.match(usa.eligibilityText!, /more than one marketing text from USA Clinics Group/);
  assert.equal(listings.find((l) => l.title.startsWith("VSL"))!.website, "https://www.vsl3lawsuit.com/");
  assert.equal(decodeEntities("Trader Joe&#8217;s &amp; Co"), "Trader Joe’s & Co");
});

test("the same settlement on two sources merges by its official domain", () => {
  const clusters = clusterListings([...topClassActionsSource.parse(TOP_CLASS_ACTIONS_FEED), ...classActionOrgSource.parse(CLASSACTION_ORG_PAGE)]);
  const vsl = clusters.filter((c) => c.some((l) => l.title.startsWith("VSL")));
  assert.equal(vsl.length, 1);
  assert.deepEqual(vsl[0]!.map((l) => l.source).sort(), ["ClassAction.org", "Top Class Actions"]);
});

test("research sweep: do-not-research and tracked settlements are skipped; only new ones reach the inbox", async () => {
  const tracker = await seededTracker();
  const result = await runResearchSweep({ tracker, fetch: fakeFetch(), sources: [topClassActionsSource, classActionOrgSource] });

  assert.deepEqual(result.reports.map((r) => [r.source, r.ok, r.listings]), [["Top Class Actions", true, 5], ["ClassAction.org", true, 7]]);
  assert.deepEqual(result.blocked.map((b) => b.blockedBy).sort(), ["Apple Siri", "Bestway spa pump", "Forbes tracking"]);
  assert.deepEqual(
    result.tracked.map((t) => t.settlementId).sort(),
    ["finwise", "inotiv", "modmed", "nonbank-atm", "usa-clinics-tcpa", "vsl3-probiotic"],
  );
  assert.deepEqual(result.fresh.map((f) => f.candidate.id).sort(), ["c-dap-health-data-breach", "c-navy-federal-credit-union-unauthorized-loans"]);

  const dap = result.fresh.find((f) => f.candidate.id === "c-dap-health-data-breach")!;
  assert.equal(dap.candidate.deadline?.date, "2026-10-21");
  assert.equal(dap.candidate.deadline?.source.label, "ClassAction.org");
  assert.equal(dap.evaluation.verdict, "unverified");
  assert.match(dap.evaluation.evidenceRequired.join(" "), /breach notice/);
  assert.equal(tracker.inbox().length, 2);
  // Nothing about the tracked settlements changed.
  assert.equal(tracker.get("vsl3-probiotic").status, "researching");

  const again = await runResearchSweep({ tracker, fetch: fakeFetch(), sources: [topClassActionsSource, classActionOrgSource] });
  assert.equal(again.fresh.length, 0, "a candidate is reported once");
  assert.equal(again.alreadySeen, 2);
  assert.equal(tracker.inbox().length, 2);
});

test("research sweep: a source's different deadline is recorded as a conflict, never applied", async () => {
  const tracker = await seededTracker();
  const at = CLASSACTION_ORG_PAGE.indexOf('id="usa-clinics-group-unwanted-texts"');
  const page = CLASSACTION_ORG_PAGE.slice(0, at) + CLASSACTION_ORG_PAGE.slice(at).replace(/(Deadline<\/span>\s*<span[^>]*>)10\/5\/26/, "$110/2/26");
  assert.notEqual(page, CLASSACTION_ORG_PAGE, "fixture edit applied");
  const result = await runResearchSweep({ tracker, fetch: fakeFetch({ pages: { [classActionOrgSource.url]: page } }), sources: [classActionOrgSource] });
  const usa = result.tracked.find((t) => t.settlementId === "usa-clinics-tcpa")!;
  assert.equal(usa.newDeadlineConflict?.date, "2026-10-02");
  const s = tracker.get("usa-clinics-tcpa");
  assert.equal(s.deadline?.date, "2026-10-05", "the owner's deadline is unchanged");
  assert.deepEqual(s.deadlineConflicts.map((c) => c.date), ["2026-10-02"]);
  // ...but alerts now act on the earlier date.
  assert.equal(tracker.dueNudges()[0]!.deadline, "2026-10-02");
  const again = await runResearchSweep({ tracker, fetch: fakeFetch({ pages: { [classActionOrgSource.url]: page } }), sources: [classActionOrgSource] });
  assert.equal(again.tracked.find((t) => t.settlementId === "usa-clinics-tcpa")!.newDeadlineConflict, undefined, "recorded once");
});

test("research sweep: one source down doesn't sink the sweep; a changed layout is reported", async () => {
  const tracker = await seededTracker();
  const down = await runResearchSweep({ tracker, fetch: fakeFetch({ fail: classActionOrgSource.url }), sources: [topClassActionsSource, classActionOrgSource] });
  assert.deepEqual(down.reports.map((r) => r.ok), [true, false]);
  assert.match(down.reports[1]!.error!, /ENOTFOUND/);
  assert.ok(down.fresh.length > 0);

  const changed = await readSource(classActionOrgSource, fakeFetch({ pages: { [classActionOrgSource.url]: "<html>new design</html>" } }));
  assert.equal(changed.report.ok, false);
  assert.match(changed.report.error!, /layout may have changed/);
  const missing = await readSource(topClassActionsSource, fakeFetch({ pages: { [topClassActionsSource.url]: undefined as unknown as string } }));
  assert.equal(missing.report.error, "HTTP 404");
});

test("research inbox: the owner promotes or permanently dismisses candidates", async () => {
  const tracker = await seededTracker();
  await runResearchSweep({ tracker, fetch: fakeFetch(), sources: [topClassActionsSource, classActionOrgSource] });

  const dap = await tracker.promote("c-dap-health-data-breach");
  assert.equal(dap.status, "researching");
  assert.equal(dap.deadline?.date, "2026-10-21");
  assert.equal(dap.eligibility.verdict, "unverified");

  await assert.rejects(tracker.promote("c-nope"), /No research candidate/);
  await tracker.dismiss("c-navy-federal-credit-union-unauthorized-loans", "Never had a Navy Federal loan");
  assert.equal(tracker.inbox().length, 0);

  const later = await runResearchSweep({ tracker, fetch: fakeFetch(), sources: [topClassActionsSource, classActionOrgSource] });
  assert.ok(later.tracked.some((t) => t.settlementId === dap.id), "promoted → tracked");
  assert.ok(later.blocked.some((b) => b.blockedBy.startsWith("Navy Federal")), "dismissed → permanently blocked");
  assert.equal(later.fresh.length, 0);
});

test("research sources only ever GET public pages", async () => {
  const fetch = fakeFetch();
  const seen: unknown[] = [];
  const spy: FetchLike = async (url, init) => {
    seen.push(init);
    return fetch(url, init);
  };
  await readSource(topClassActionsSource, spy);
  const init = seen[0] as Record<string, unknown>;
  assert.equal(init["method"], undefined, "no method means GET");
  assert.equal(init["body"], undefined);
});
