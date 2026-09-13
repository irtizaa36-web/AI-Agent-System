import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupe, mergeSighting } from "./dedupe";
import type { JobRecord } from "./records";

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
    sources: [{ sourceId: "greenhouse:acme", url: "https://a.test/1", fetchedAt: "2026-09-13T08:00:00.000Z" }],
    applyUrl: "https://a.test/1",
    descriptionPath: "/tmp/1.html",
    summary: "Own demand gen.",
    state: "seen",
    filterReason: null,
    score: null,
    confidence: null,
    rationale: null,
    gaps: [],
    ...overrides,
  };
}

test("dedupe treats an unseen posting as fresh", () => {
  const result = dedupe([job()], []);
  assert.equal(result.fresh.length, 1);
  assert.equal(result.duplicateCount, 0);
});

test("dedupe drops a posting whose content hash is already known", () => {
  const result = dedupe([job()], [job()]);
  assert.equal(result.fresh.length, 0);
  assert.equal(result.duplicateCount, 1);
});

test("dedupe collapses the same role found on two different boards in one run", () => {
  const fromLever = job({
    id: "job-2",
    contentHash: "hash-2",
    sources: [{ sourceId: "lever:acme", url: "https://b.test/2", fetchedAt: "2026-09-13T08:00:00.000Z" }],
  });

  const result = dedupe([job(), fromLever], []);

  assert.equal(result.fresh.length, 1, "one role, not two");
  assert.equal(result.fresh[0]?.sources.length, 2, "carrying both links");
});

test("mergeSighting never resets an existing score or state", () => {
  const scored = job({ state: "shortlisted", score: 88, rationale: "Strong fit." });
  const rediscovered = job({ sources: [{ sourceId: "lever:acme", url: "https://b.test/2", fetchedAt: "x" }] });

  const merged = mergeSighting(scored, rediscovered);

  assert.equal(merged.state, "shortlisted");
  assert.equal(merged.score, 88);
  assert.equal(merged.sources.length, 2);
});

test("mergeSighting fills in a salary that a later sighting stated, but never erases one", () => {
  const withPay = job({ salaryMin: 120000, salaryMax: 150000, salaryCurrency: "USD" });
  const withoutPay = job();

  assert.equal(mergeSighting(withoutPay, withPay).salaryMax, 150000);
  assert.equal(mergeSighting(withPay, withoutPay).salaryMax, 150000);
});
