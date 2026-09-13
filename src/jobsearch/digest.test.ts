import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDigest, digestPayload, type RunSummary } from "./digest";
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
    state: "shortlisted",
    filterReason: null,
    score: 88,
    confidence: "high",
    rationale: "Squarely your demand-gen background at the level you want.",
    gaps: [],
    ...overrides,
  };
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    startedAt: "2026-09-13T08:00:00.000Z",
    finishedAt: "2026-09-13T08:02:00.000Z",
    fetchedCount: 120,
    newCount: 9,
    duplicateCount: 111,
    filteredCount: 6,
    scoredCount: 3,
    shortlisted: [job()],
    alsoSeen: [],
    health: [{ sourceId: "greenhouse:acme", state: "ok", postingCount: 120, error: null, checkedAt: "x" }],
    failures: [],
    costUsd: 0.0412,
    inputTokens: 20000,
    outputTokens: 4500,
    ...overrides,
  };
}

test("the digest leads with the count, the cost and the roles", () => {
  const markdown = renderDigest(summary());
  assert.match(markdown, /# Job digest — 2026-09-13/);
  assert.match(markdown, /1 role worth a look/);
  assert.match(markdown, /\$0\.04/);
  assert.match(markdown, /Marketing Manager — Acme/);
  assert.match(markdown, /\[Apply\]\(https:\/\/a\.test\/1\)/);
});

test("a role with no stated pay says so rather than showing a number", () => {
  const markdown = renderDigest(summary());
  assert.match(markdown, /Pay not stated/);
  assert.doesNotMatch(markdown, /\$\d{2,3},\d{3}/);
});

test("a stated range is printed as published", () => {
  const markdown = renderDigest(summary({ shortlisted: [job({ salaryMin: 130000, salaryMax: 160000, salaryCurrency: "USD" })] }));
  assert.match(markdown, /130,000–160,000 USD/);
});

test("gaps are shown next to the role, not buried", () => {
  const markdown = renderDigest(summary({ shortlisted: [job({ gaps: ["Paid search ownership", "Team of 5+"] })] }));
  assert.match(markdown, /\*\*Gaps:\*\* Paid search ownership; Team of 5\+/);
});

test("an empty run says so plainly instead of rendering an empty list", () => {
  assert.match(renderDigest(summary({ shortlisted: [], scoredCount: 0 })), /No new roles cleared the score cutoff/);
});

test("every digest states that nothing was applied to or sent", () => {
  assert.match(renderDigest(summary()), /Nothing was applied to, nobody was contacted, and no message was sent/);
});

test("cross-posted roles list their other links", () => {
  const markdown = renderDigest(
    summary({
      shortlisted: [
        job({
          sources: [
            { sourceId: "greenhouse:acme", url: "https://a.test/1", fetchedAt: "x" },
            { sourceId: "lever:acme", url: "https://b.test/2", fetchedAt: "x" },
          ],
        }),
      ],
    }),
  );
  assert.match(markdown, /Also posted: \[lever:acme\]\(https:\/\/b\.test\/2\)/);
});

test("the dashboard payload reports whether pay was stated, without inventing a figure", () => {
  const payload = digestPayload(summary()) as { shortlisted: { salaryStated: boolean; salaryMin: number | null }[] };
  assert.equal(payload.shortlisted[0]?.salaryStated, false);
  assert.equal(payload.shortlisted[0]?.salaryMin, null);
});
