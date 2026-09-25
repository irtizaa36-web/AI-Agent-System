import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daysUntil, isIsoDate, parseUsDate, todayIn } from "./dates";
import { dueNudges, effectiveDeadline, NUDGE_THRESHOLDS, toNudgeRecord, urgencyOf } from "./deadlines";
import { evaluate, inferCriteria, OWNER_PROFILE } from "./eligibility";
import { domainOf, identityKeys, isSameAs, isSameListing, nameTokens, slugify } from "./matching";
import { parsePayout, rankingValue } from "./payout";
import { priority } from "./scoring";
import { seedDocument } from "./seed";
import { InMemoryTrackerStorage, JsonFileTrackerStorage } from "./storage";
import { SettlementTracker, TrackerError } from "./tracker";
import type { IsoDate, NudgeRecord, Settlement } from "./types";

const TODAY = "2026-09-25";

async function openSeeded(today: IsoDate = TODAY, storage = new InMemoryTrackerStorage()) {
  let now = today;
  const tracker = await SettlementTracker.open(storage, { today: () => now, seed: seedDocument });
  return { tracker, storage, setToday: (d: IsoDate) => (now = d) };
}

// ── dates ────────────────────────────────────────────────────────────────

test("dates: days-until counts calendar days and rejects bad dates", () => {
  assert.equal(daysUntil("2026-10-05", TODAY), 10);
  assert.equal(daysUntil(TODAY, TODAY), 0);
  assert.equal(daysUntil("2026-09-24", TODAY), -1);
  assert.equal(daysUntil("2027-02-10", "2026-12-31"), 41);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.throws(() => daysUntil("10/05/2026", TODAY), /YYYY-MM-DD/);
  assert.equal(parseUsDate("10/20/26"), "2026-10-20");
  assert.equal(parseUsDate("Deadline 02/10/2027 Case Name"), "2027-02-10");
  assert.equal(parseUsDate("13/40/2026"), undefined);
  // 03:00 UTC on the 26th is still the 25th in Texas.
  assert.equal(todayIn("America/Chicago", new Date("2026-09-26T03:00:00Z")), "2026-09-25");
});

// ── matching ─────────────────────────────────────────────────────────────

test("matching: names normalize across sources, domains win when both are known", () => {
  assert.deepEqual(nameTokens("$20M VSL Pharmaceuticals probiotic class action settlement"), nameTokens("VSL Pharmaceuticals - Probiotics"));
  assert.deepEqual(nameTokens("Trader Joe's FACTA"), ["trader", "joe", "facta"]);
  assert.equal(domainOf("https://www.VSL3Lawsuit.com/submit-claim"), "vsl3lawsuit.com");
  assert.equal(domainOf("VSL3Lawsuit.com"), "vsl3lawsuit.com");
  assert.equal(domainOf("not a url"), undefined);
  assert.equal(slugify("Altrua Ministries - Unwanted Calls"), "altrua-ministries-unwanted-calls");

  // Do-not-research matching: all of the known name's tokens must appear.
  assert.ok(isSameAs({ names: ["Apple Siri"], domains: [] }, { names: ["iPhone - Siri Apple Intelligence"], domains: [] }));
  assert.ok(isSameAs({ names: ["Forbes tracking"], domains: [] }, { names: ["Forbes Media website tracking"], domains: [] }));
  assert.ok(isSameAs({ names: ["Bestway spa pump"], domains: [] }, { names: ["Bestway Spa Pumps"], domains: [] }));
  assert.ok(!isSameAs({ names: ["Bestway spa pump"], domains: [] }, { names: ["Bestway above-ground pools"], domains: [] }), "the pool settlement is not the spa pump one");
  assert.ok(isSameAs({ names: ["Non-bank ATM surcharges"], domains: [] }, { names: ["Non-Bank ATM Surcharges"], domains: [] }));
  // A shared domain matches regardless of name; disjoint domains veto a name match.
  assert.ok(isSameAs({ names: ["x"], domains: ["vsl3lawsuit.com"] }, { names: ["totally different"], domains: ["vsl3lawsuit.com"] }));
  assert.ok(!isSameAs({ names: ["Forbes tracking"], domains: ["a.com"] }, { names: ["Forbes tracking"], domains: ["b.com"] }));
  // A one-word name only matches exactly, so "Amazon" can't swallow every Amazon settlement.
  assert.ok(!isSameAs({ names: ["Amazon"], domains: [] }, { names: ["Amazon Prime video"], domains: [] }));

  assert.ok(isSameListing({ names: ["$20M VSL Pharmaceuticals probiotic class action settlement"], domains: [] }, { names: ["VSL Pharmaceuticals - Probiotics"], domains: [] }));
  assert.ok(!isSameListing({ names: ["Tift Regional Health data breach"], domains: [] }, { names: ["Palomar Health data breach"], domains: [] }), "category words alone never merge");
  assert.ok(!isSameListing({ names: ["Costa Del Mar sunglasses warranty"], domains: ["a.com"] }, { names: ["Costa Del Mar sunglasses repair"], domains: ["b.com"] }));
  assert.deepEqual(identityKeys({ names: ["VSL Pharmaceuticals - Probiotics"], domains: ["vsl3lawsuit.com"] }), ["domain:vsl3lawsuit.com", "name:pharmaceutical probiotic vsl"]);
});

// ── payout & scoring ─────────────────────────────────────────────────────

test("payout: source wording becomes ranking bounds, never a promised amount", () => {
  assert.deepEqual(parsePayout("Up to $800"), { ceiling: 800, perUnit: false });
  assert.deepEqual(parsePayout("$50 - $150"), { floor: 50, ceiling: 150, perUnit: false });
  assert.deepEqual(parsePayout("$20 Per Unit"), { floor: 20, ceiling: 20, perUnit: true });
  assert.deepEqual(parsePayout("Between $250 and $650"), { floor: 250, ceiling: 650, perUnit: false });
  assert.deepEqual(parsePayout("$40+"), { floor: 40, perUnit: false });
  assert.deepEqual(parsePayout("Varies"), { perUnit: false });
  assert.equal(rankingValue(parsePayout("Up to $5,000 in documented losses")), 75, "a lone ceiling is heavily discounted");
  assert.equal(rankingValue(parsePayout("Up to $300")), 30);
  assert.equal(rankingValue(parsePayout(undefined)), 10);
});

test("scoring: not-eligible and expired score zero; eligible, valuable and urgent rank first", () => {
  const ev = evaluate([{ kind: "profile", fact: "renter", description: "Rents" }]);
  assert.equal(priority({ verdict: "not_eligible", today: TODAY, deadline: "2026-10-01" }).score, 0);
  assert.equal(priority({ verdict: "eligible", evaluation: ev, today: TODAY, deadline: "2026-09-01" }).score, 0);
  const urgent = priority({ verdict: "eligible", evaluation: ev, today: TODAY, deadline: "2026-10-01", payoutText: "$100" }).score;
  const distant = priority({ verdict: "eligible", evaluation: ev, today: TODAY, deadline: "2027-06-01", payoutText: "$100" }).score;
  const unverified = priority({ verdict: "unverified", evaluation: evaluate([{ kind: "evidence", description: "x" }]), today: TODAY, deadline: "2026-10-01", payoutText: "$100" }).score;
  assert.ok(urgent > distant && urgent > unverified && unverified > 0, `${urgent} ${distant} ${unverified}`);
});

// ── eligibility ──────────────────────────────────────────────────────────

test("eligibility: explicit verdicts from the owner's profile, with the evidence still required", () => {
  const forbes = evaluate(inferCriteria("Forbes Media website tracking", "The class action settlement benefits California residents who accessed websites owned by Forbes."));
  assert.equal(forbes.verdict, "not_eligible");
  assert.match(forbes.summary, /CA residents; owner lives in TX/);

  const texas = evaluate([{ kind: "residence", states: ["TX"], description: "Texas resident" }]);
  assert.equal(texas.verdict, "eligible");

  const cvs = evaluate(inferCriteria("CVS - Data Privacy", "You may be included if you accessed the CVS website or app prior to July 27, 2026."));
  assert.equal(cvs.verdict, "eligible", "CVS app use is on the profile");

  const tcpa = evaluate(inferCriteria("Concora Credit TCPA", "anyone who received a call from Concora Credit using a prerecorded voice"));
  assert.equal(tcpa.verdict, "unverified", "getting robocalls in general doesn't prove this defendant called");
  assert.match(tcpa.evidenceRequired.join(" "), /came from this defendant/);

  const breach = evaluate(inferCriteria("Urban One - Data Breach", "if your personal information was exposed in the Urban One data breach"));
  assert.equal(breach.verdict, "unverified");
  assert.match(breach.evidenceRequired[0]!, /breach notice/);

  const siri = evaluate(inferCriteria("iPhone - Siri Apple Intelligence", "if you bought an iPhone 15 Pro or any iPhone 16 model"));
  assert.equal(siri.verdict, "unverified");
  assert.match(siri.evidenceRequired.join(" "), /specific iPhone models/);

  const stateInTitle = evaluate(inferCriteria("High 5 Games (Washington)", "players of High 5 Games"));
  assert.equal(stateInTitle.verdict, "not_eligible");

  const unknownFact = evaluate([{ kind: "profile", fact: "renter", description: "Rents" }], { residenceState: "TX", facts: {} });
  assert.equal(unknownFact.verdict, "unverified", "a fact the profile doesn't state is unknown, not assumed");
  assert.equal(evaluate([]).verdict, "unverified", "nothing checkable is never eligible");
  assert.equal(evaluate([{ kind: "profile", fact: "renter", description: "Rents" }], { residenceState: "TX", facts: { renter: false } }).verdict, "not_eligible");
});

// ── seed ─────────────────────────────────────────────────────────────────

test("seed: the owner's real pipeline, exact deadlines, no fabricated confirmation", () => {
  const doc = seedDocument();
  const byId = new Map(doc.settlements.map((s) => [s.id, s]));
  const expected: Record<string, string> = {
    "usa-clinics-tcpa": "2026-10-05",
    "vsl3-probiotic": "2026-10-20",
    finwise: "2026-10-29",
    "bestway-pool": "2026-10-30",
    modmed: "2026-11-02",
    "dr-squatch": "2026-11-27",
    "amazon-returns": "2026-12-01",
    inotiv: "2026-12-02",
    "nonbank-atm": "2027-02-10",
    realpage: "2027-01-29",
  };
  for (const [id, date] of Object.entries(expected)) {
    const s = byId.get(id);
    assert.ok(s, id);
    assert.equal(s.deadline?.date, date, id);
    assert.equal(s.status, "researching", id);
    assert.equal(s.eligibility.verdict, "unverified", `${id}: nobody has recorded evidence of eligibility yet`);
    assert.ok(s.actions.some((a) => a.kind === "attestation"), `${id} tracks the owner's own attestation`);
    if (s.payout) assert.ok(s.payout.source.label.length > 0, `${id} payout is sourced`);
  }

  const cvs = byId.get("cvs-digital-privacy")!;
  assert.equal(cvs.status, "filed");
  assert.equal(cvs.filedOn, "2026-09-21");
  assert.equal(cvs.confirmation, undefined, "the public repo holds no confirmation number; the owner records it locally");

  const dropped = doc.settlements.filter((s) => s.status === "dropped");
  assert.equal(dropped.length, 13);
  for (const s of dropped) assert.ok(s.dropReason && s.dropReason.length > 0, s.id);
  assert.equal(byId.get("apple-siri")!.eligibility.verdict, "not_eligible");
  assert.equal(byId.get("connectoncall")!.eligibility.verdict, "not_eligible");
  assert.equal(doc.doNotResearch.length, 13);

  // The ATM sources disagree; the earliest date drives alerts.
  assert.equal(effectiveDeadline(byId.get("nonbank-atm")!), "2027-02-10");
  assert.equal(byId.get("nonbank-atm")!.deadlineConflicts[0]!.date, "2027-02-27");
});

// ── deadline engine ──────────────────────────────────────────────────────

function settlementWith(deadline: IsoDate, overrides: Partial<Settlement> = {}): Settlement {
  const base = seedDocument().settlements.find((s) => s.id === "finwise")!;
  return { ...base, deadline: { date: deadline, source: { label: "test", retrievedOn: TODAY } }, deadlineConflicts: [], ...overrides };
}

test("deadlines: each threshold fires once, missed marks collapse, extensions re-arm", () => {
  assert.deepEqual(NUDGE_THRESHOLDS, [14, 7, 3, 1]);
  assert.equal(urgencyOf(-1), "overdue");
  assert.equal(urgencyOf(0), "today");
  assert.equal(urgencyOf(3), "critical");
  assert.equal(urgencyOf(undefined), "no_deadline");

  const s = settlementWith("2026-10-09"); // 14 days out
  const sent: NudgeRecord[] = [];
  const first = dueNudges([s], sent, TODAY);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.threshold, 14);
  sent.push(toNudgeRecord(first[0]!, TODAY));
  assert.equal(dueNudges([s], sent, TODAY).length, 0, "same nudge never repeats");
  assert.equal(dueNudges([s], sent, "2026-09-28").length, 0, "11 days left: nothing new between marks");

  // Nothing ran for a week: 7 days left AND 3 days left both crossed → only the 3-day nudge.
  const late = dueNudges([s], sent, "2026-10-06");
  assert.deepEqual(late.map((n) => n.threshold), [3]);
  sent.push(toNudgeRecord(late[0]!, "2026-10-06"));
  assert.equal(dueNudges([s], sent, "2026-10-06").length, 0);
  assert.deepEqual(dueNudges([s], sent, "2026-10-08").map((n) => n.threshold), [1]);
  assert.equal(dueNudges([s], sent, "2026-10-10").length, 0, "overdue items get no nudge");

  // The deadline was extended: a new deadline is a new set of nudges.
  const extended = settlementWith("2026-10-15");
  assert.deepEqual(dueNudges([extended], sent, "2026-10-08").map((n) => n.threshold), [7]);

  // Filed and dropped claims never nudge.
  assert.equal(dueNudges([settlementWith("2026-09-26", { status: "filed" }), settlementWith("2026-09-26", { status: "dropped" })], [], TODAY).length, 0);
  // Conflicting sources: the earlier date drives the nudge.
  const conflicted = settlementWith("2026-11-30", { deadlineConflicts: [{ date: "2026-10-01", source: { label: "other", retrievedOn: TODAY } }] });
  assert.equal(dueNudges([conflicted], [], TODAY)[0]!.deadline, "2026-10-01");
});

// ── tracker ──────────────────────────────────────────────────────────────

test("tracker: statuses change only on evidence, along allowed paths", async () => {
  const { tracker } = await openSeeded();
  await assert.rejects(tracker.transition("finwise", "filed", { evidence: " " }), /Evidence .* required/);
  await assert.rejects(tracker.transition("finwise", "ready_to_file", { evidence: "looks good" }), /unverified.*eligible/);
  await assert.rejects(tracker.transition("finwise", "paid", { evidence: "x", amount: 10, paidOn: TODAY }), /can't go from researching to paid/);
  await assert.rejects(tracker.transition("finwise", "filed", { evidence: "I filed" }), /--filed-on/);
  await assert.rejects(tracker.transition("finwise", "filed", { evidence: "I filed", filedOn: "2026-09-30" }), /future/);
  await assert.rejects(tracker.transition("finwise", "filed", { evidence: "I filed", filedOn: TODAY, confirmation: "a b" }), /confirmation number/);
  await assert.rejects(tracker.setVerdict("finwise", "eligible", ""), /Evidence/);

  await tracker.setVerdict("finwise", "eligible", "Found the FinWise notice letter dated 2024-07-12");
  const ready = await tracker.transition("finwise", "ready_to_file", { evidence: "Notice found, Class Member ID in hand" });
  assert.equal(ready.status, "ready_to_file");
  const filed = await tracker.transition("finwise", "filed", { evidence: "Submitted it myself on the site", filedOn: TODAY, confirmation: "FW-12345" });
  assert.equal(filed.confirmation, "FW-12345");
  await assert.rejects(tracker.recordConfirmation("finwise", "FW-99999"), /not overwriting/);
  await assert.rejects(tracker.transition("finwise", "paid", { evidence: "check arrived" }), /--amount/);
  const paid = await tracker.transition("finwise", "paid", { evidence: "check arrived", amount: 61.5, paidOn: TODAY });
  assert.deepEqual(paid.paid, { amount: 61.5, on: TODAY });
  await assert.rejects(tracker.transition("finwise", "dropped", { evidence: "x" }), /paid is final/);
  assert.deepEqual(paid.history.map((h) => h.to), ["researching", "ready_to_file", "filed", "paid"]);
});

test("tracker: dropping is permanent and joins the do-not-research list", async () => {
  const { tracker } = await openSeeded();
  await tracker.transition("inotiv", "dropped", { evidence: "Never had a relationship with Inotiv" });
  assert.ok(tracker.blockedBy({ names: ["Inotiv - Data Breach"], domains: [] }));
  await assert.rejects(tracker.transition("inotiv", "researching", { evidence: "changed my mind" }), /dropped is final/);
  await assert.rejects(tracker.add({ name: "Inotiv data breach", deadline: { date: "2026-12-02", source: { label: "x", retrievedOn: TODAY } } }), /do-not-research list/);
});

test("tracker: adding requires a sourced deadline and refuses duplicates", async () => {
  const { tracker } = await openSeeded();
  const src = { label: "https://example-settlement.com", retrievedOn: TODAY };
  await assert.rejects(tracker.add({ name: "New thing", deadline: { date: "Oct 3", source: src } }), /YYYY-MM-DD/);
  await assert.rejects(tracker.add({ name: "New thing", deadline: { date: "2026-10-03", source: { label: " ", retrievedOn: TODAY } } }), /source/);
  await assert.rejects(tracker.add({ name: "VSL Pharmaceuticals - Probiotics", deadline: { date: "2026-10-20", source: src } }), /already tracked as vsl3-probiotic/);
  const added = await tracker.add({ name: "Urban One - Data Breach", deadline: { date: "2026-10-12", source: src } });
  assert.equal(added.id, "urban-one-data-breach");
  assert.equal(added.eligibility.verdict, "unverified");
  assert.match(added.history[0]!.evidence, /deadline source: https:\/\/example-settlement.com/);
});

test("tracker: action items track what only the owner can do", async () => {
  const { tracker } = await openSeeded();
  const action = await tracker.addAction("vsl3-probiotic", "verification_code", "Enter the emailed code on the claim site");
  assert.equal(action.id, "a4");
  const done = await tracker.completeAction("vsl3-probiotic", "a1", "Bought 6 units in 2017");
  assert.equal(done.done, true);
  assert.equal(done.note, "Bought 6 units in 2017");
  await assert.rejects(tracker.completeAction("vsl3-probiotic", "a1"), /already done/);
  await assert.rejects(tracker.completeAction("vsl3-probiotic", "a99"), /no action/);
});

test("tracker: confirmation numbers are recorded only for filed claims, exactly as given", async () => {
  const { tracker } = await openSeeded();
  await assert.rejects(tracker.recordConfirmation("finwise", "ABCD1234"), /isn't filed/);
  const cvs = await tracker.recordConfirmation("cvs-digital-privacy", "ABCD1234ef");
  assert.equal(cvs.confirmation, "ABCD1234ef");
});

test("tracker: nudges are persisted so they never repeat across runs", async () => {
  const storage = new InMemoryTrackerStorage();
  const a = await openSeeded(TODAY, storage);
  const due = a.tracker.dueNudges();
  assert.deepEqual(due.map((n) => [n.settlement.id, n.threshold]), [["usa-clinics-tcpa", 14]]);
  await a.tracker.markNudged(due);
  const b = await openSeeded(TODAY, storage);
  assert.equal(b.tracker.dueNudges().length, 0);
  b.setToday("2026-09-28");
  assert.deepEqual(b.tracker.dueNudges().map((n) => n.threshold), [7]);
});

test("tracker snapshots can't be used to bypass the rules", async () => {
  const { tracker } = await openSeeded();
  const snap = tracker.snapshot();
  (snap.settlements[0] as { status: string }).status = "filed";
  assert.equal(tracker.get(snap.settlements[0]!.id).status, "researching");
});

// ── storage ──────────────────────────────────────────────────────────────

test("storage: JSON file round-trips, seeds once, and never silently resets a damaged file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "settlements-"));
  try {
    const path = join(dir, "nested", "tracker.json");
    const first = await openSeeded(TODAY, new JsonFileTrackerStorage(path) as unknown as InMemoryTrackerStorage);
    await first.tracker.recordConfirmation("cvs-digital-privacy", "5c4bTEST0001");
    const second = await SettlementTracker.open(new JsonFileTrackerStorage(path), { today: () => TODAY, seed: () => assert.fail("must not re-seed") });
    assert.equal(second.get("cvs-digital-privacy").confirmation, "5c4bTEST0001");

    await writeFile(path, "{ not json");
    await assert.rejects(SettlementTracker.open(new JsonFileTrackerStorage(path), { today: () => TODAY, seed: seedDocument }), /not valid JSON.*not overwritten/);
    assert.equal(await readFile(path, "utf-8"), "{ not json");

    await writeFile(path, JSON.stringify({ version: 1, settlements: [{ id: "x", name: "x", status: "won" }], doNotResearch: [], inbox: [], seenKeys: [], nudges: [] }));
    await assert.rejects(new JsonFileTrackerStorage(path).load(), /unknown status won/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TrackerError is what callers see for rule violations", async () => {
  const { tracker } = await openSeeded();
  await assert.rejects(tracker.transition("nope", "filed", { evidence: "x" }), (e: unknown) => e instanceof TrackerError);
  assert.equal(OWNER_PROFILE.residenceState, "TX");
});
