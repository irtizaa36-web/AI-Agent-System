import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFilters, salaryUnknown } from "./filter";
import { DEFAULT_PREFERENCES, type JobRecord, type Preferences } from "./records";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    contentHash: "hash-1",
    identityKey: "acme::marketing manager::remote",
    title: "Marketing Manager",
    company: "Acme",
    rawLocation: "Remote",
    locationClass: "remote",
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    postedAt: null,
    firstSeenAt: "2026-09-13T08:00:00.000Z",
    lastSeenAt: "2026-09-13T08:00:00.000Z",
    sources: [],
    applyUrl: "https://a.test/1",
    descriptionPath: "/tmp/1.html",
    summary: "Own demand generation for the growth team.",
    state: "seen",
    filterReason: null,
    score: null,
    confidence: null,
    rationale: null,
    gaps: [],
    ...overrides,
  };
}

const prefs: Preferences = { ...DEFAULT_PREFERENCES, titles: ["marketing manager", "growth manager"] };

test("a remote role with a matching title passes", () => {
  assert.equal(applyFilters(job(), prefs).passed, true);
});

test("a title outside the cluster is rejected before any model call", () => {
  const outcome = applyFilters(job({ title: "Staff Backend Engineer" }), prefs);
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /outside the target cluster/);
});

test("an empty titles list lets everything through rather than rejecting the whole market", () => {
  const outcome = applyFilters(job({ title: "Staff Backend Engineer" }), { ...prefs, titles: [] });
  assert.equal(outcome.passed, true);
});

test("an onsite role is rejected under remote-only", () => {
  const outcome = applyFilters(job({ locationClass: "onsite", rawLocation: "Chicago, IL" }), prefs);
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /Not remote/);
});

test("a named metro re-admits an onsite role", () => {
  const outcome = applyFilters(job({ locationClass: "onsite", rawLocation: "Chicago, IL" }), {
    ...prefs,
    metros: ["Chicago"],
  });
  assert.equal(outcome.passed, true);
});

test("a posting below the stated salary floor is rejected with the numbers in the reason", () => {
  const outcome = applyFilters(job({ salaryMin: 70000, salaryMax: 80000, salaryCurrency: "USD" }), {
    ...prefs,
    salaryFloor: 120000,
  });
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /80,000/);
  assert.match(outcome.reason ?? "", /120,000/);
});

test("a posting that states NO salary passes the floor and is flagged unknown, never guessed", () => {
  const record = job();
  const outcome = applyFilters(record, { ...prefs, salaryFloor: 120000 });

  assert.equal(outcome.passed, true, "silence about pay is not evidence of low pay");
  assert.equal(salaryUnknown(record), true);
});

test("an excluded title and an excluded company are both rejected", () => {
  assert.equal(applyFilters(job({ title: "Marketing Manager Intern" }), prefs).passed, false);
  assert.equal(applyFilters(job(), { ...prefs, companyExclusions: ["Acme Inc."] }).passed, false);
});

test("an industry exclusion matches on the posting body", () => {
  const outcome = applyFilters(job({ summary: "Own demand gen for our sports betting brand." }), {
    ...prefs,
    industryExclusions: ["sports betting"],
  });
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /Industry excluded/);
});
