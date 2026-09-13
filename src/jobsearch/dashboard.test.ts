import { test } from "node:test";
import assert from "node:assert/strict";
import { renderJobsPage } from "./dashboard";

test("the page renders a scored role with its rationale and a link to the real posting", () => {
  const html = renderJobsPage({
    startedAt: "2026-09-13T08:00:00.000Z",
    counts: { fetched: 120, new: 9, filtered: 6 },
    costUsd: 0.041,
    shortlisted: [
      {
        title: "Marketing Manager",
        company: "Acme",
        locationClass: "remote",
        salaryStated: true,
        salaryMin: 130000,
        salaryMax: 160000,
        score: 88,
        confidence: "high",
        rationale: "Squarely your demand-gen background.",
        gaps: ["Paid search ownership"],
        applyUrl: "https://a.test/1",
      },
    ],
  });

  assert.match(html, /Marketing Manager/);
  assert.match(html, /88\/100/);
  assert.match(html, /130,000–160,000/);
  assert.match(html, /Paid search ownership/);
  assert.match(html, /href="https:\/\/a\.test\/1"/);
});

test("a role with no stated pay says so instead of showing a number", () => {
  const html = renderJobsPage({
    counts: {},
    costUsd: 0,
    shortlisted: [{ title: "X", company: "Y", locationClass: "remote", salaryStated: false, salaryMin: null, salaryMax: null, score: 70, confidence: "medium", rationale: "ok", gaps: [], applyUrl: "https://a.test/1" }],
  });

  assert.match(html, /Pay not stated/);
  assert.doesNotMatch(html, /NaN/);
});

test("the page escapes posting text rather than trusting a job board's HTML", () => {
  const html = renderJobsPage({
    counts: {},
    costUsd: 0,
    shortlisted: [
      {
        title: "<img src=x onerror=alert(1)>",
        company: "Acme",
        locationClass: "remote",
        salaryStated: false,
        score: 70,
        confidence: "low",
        rationale: "fine",
        gaps: [],
        applyUrl: "https://a.test/1",
      },
    ],
  });

  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("with no digest yet the page says what to run, rather than looking broken", () => {
  assert.match(renderJobsPage(null), /No digest yet/);
});

test("broken sources are surfaced on the page, not hidden", () => {
  const html = renderJobsPage({
    counts: {},
    costUsd: 0,
    shortlisted: [],
    health: [{ sourceId: "greenhouse:acme", state: "degraded", error: "HTTP 404" }],
  });

  assert.match(html, /Sources needing attention/);
  assert.match(html, /HTTP 404/);
});

test("every page states that nothing was applied to or sent", () => {
  assert.match(renderJobsPage(null), /Nothing here has been applied to, nobody has been contacted/);
});
