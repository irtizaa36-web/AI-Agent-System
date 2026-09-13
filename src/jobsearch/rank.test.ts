import { test } from "node:test";
import assert from "node:assert/strict";
import { rankKey, sortByRank } from "./rank";
import { DEFAULT_PREFERENCES, type JobRecord, type Preferences } from "./records";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    contentHash: "hash-1",
    identityKey: "acme::marketing manager::remote",
    title: "Marketing Manager",
    company: "Acme",
    rawLocation: "Remote - US",
    locationClass: "remote",
    remoteRegion: "us",
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    postedAt: null,
    firstSeenAt: "2026-09-13T08:00:00.000Z",
    lastSeenAt: "2026-09-13T08:00:00.000Z",
    sources: [],
    applyUrl: "https://a.test/1",
    descriptionPath: "/tmp/1.html",
    summary: "Own demand gen.",
    state: "scored",
    filterReason: null,
    score: 70,
    confidence: "high",
    rationale: "Good fit.",
    gaps: [],
    ...overrides,
  };
}

const prefs: Preferences = { ...DEFAULT_PREFERENCES, unstatedSalaryRankPenalty: 8 };

test("rankKey subtracts the penalty only when salary is unstated", () => {
  assert.equal(rankKey(job({ score: 70 }), prefs), 62);
  assert.equal(rankKey(job({ score: 70, salaryMin: 100000, salaryMax: 120000 }), prefs), 70);
});

test("rankKey never changes the record's own score field — only the sort key", () => {
  const record = job({ score: 70 });
  rankKey(record, prefs);
  assert.equal(record.score, 70, "the stored score must stay the model's honest judgment");
});

test("a strong unstated-pay match still beats a weak stated-pay one", () => {
  const strongUnstated = job({ id: "a", score: 78 });
  const weakStated = job({ id: "b", score: 68, salaryMin: 90000, salaryMax: 100000 });

  const [first] = sortByRank([weakStated, strongUnstated], prefs);
  assert.equal(first?.id, "a", "78 - 8 = 70 still beats 68");
});

test("two close scores favor the pay-transparent one", () => {
  const unstated = job({ id: "a", score: 75 });
  const stated = job({ id: "b", score: 72, salaryMin: 130000, salaryMax: 150000 });

  const [first] = sortByRank([unstated, stated], prefs);
  assert.equal(first?.id, "b", "75 - 8 = 67, which is below the stated role's 72");
});

test("a penalty of 0 disables de-prioritization entirely — pure score order", () => {
  const off: Preferences = { ...prefs, unstatedSalaryRankPenalty: 0 };
  const unstated = job({ id: "a", score: 75 });
  const stated = job({ id: "b", score: 72, salaryMin: 130000, salaryMax: 150000 });

  const [first] = sortByRank([unstated, stated], off);
  assert.equal(first?.id, "a");
});

test("sortByRank is a stable sort — equal keys keep their original order", () => {
  const first = job({ id: "a", score: 70 });
  const second = job({ id: "b", score: 70 });
  const result = sortByRank([first, second], prefs);
  assert.deepEqual(result.map((r) => r.id), ["a", "b"]);
});

test("sortByRank does not mutate the input array", () => {
  const records = [job({ id: "a", score: 60 }), job({ id: "b", score: 90 })];
  const original = [...records];
  sortByRank(records, prefs);
  assert.deepEqual(records, original);
});
