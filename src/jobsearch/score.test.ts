import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBatchPrompt, buildSystemPrompt, chunk, parseScoringResponse, scoreRecords } from "./score";
import { DEFAULT_PREFERENCES, type JobRecord, type Preferences } from "./records";
import { FakeScoringClient } from "./scoring-client";
import { CostLedger } from "./cost";
import { join } from "node:path";
import { tmpdir } from "node:os";

function job(id: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    contentHash: `hash-${id}`,
    identityKey: `acme::manager::remote`,
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
    summary: "Own demand generation.",
    state: "seen",
    filterReason: null,
    score: null,
    confidence: null,
    rationale: null,
    gaps: [],
    ...overrides,
  };
}

const prefs: Preferences = { ...DEFAULT_PREFERENCES, titles: ["marketing manager"], scoringBatchSize: 2, scoreCutoff: 65 };
const profile = { resume: "Ten years in demand generation.", notes: "" };
const ledgerPath = join(tmpdir(), `costs-${process.pid}.jsonl`);

test("chunk splits into batches of the configured size", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("the system prompt carries the rubric, targets and resume; the batch prompt carries only postings", () => {
  const system = buildSystemPrompt(profile, prefs);
  assert.match(system, /marketing manager/);
  assert.match(system, /Ten years in demand generation/);
  assert.match(system, /Remote roles only/);

  const batch = buildBatchPrompt([job("a")]);
  assert.doesNotMatch(batch, /Ten years in demand generation/, "the resume must stay in the cached prefix");
  assert.match(batch, /Marketing Manager/);
});

test("a posting with no stated salary is described as not stated, not omitted", () => {
  assert.match(buildBatchPrompt([job("a")]), /"salary": "not stated"/);
});

test("parseScoringResponse reads a clean array", () => {
  const parsed = parseScoringResponse('[{"id":"a","score":88,"confidence":"high","rationale":"Good.","gaps":[]}]');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.score, 88);
  assert.equal(parsed[0]?.confidence, "high");
});

test("parseScoringResponse tolerates a code fence but not a missing id", () => {
  const fenced = parseScoringResponse('```json\n[{"id":"a","score":70,"confidence":"medium","rationale":"ok","gaps":[]}]\n```');
  assert.equal(fenced[0]?.id, "a");

  assert.throws(() => parseScoringResponse('[{"score":70}]'), /no id/);
});

test("parseScoringResponse clamps an out-of-range score and defaults an unknown confidence to low", () => {
  const parsed = parseScoringResponse('[{"id":"a","score":120,"confidence":"certain","rationale":"x","gaps":[]}]');
  assert.equal(parsed[0]?.score, 100);
  assert.equal(parsed[0]?.confidence, "low");
});

test("scoreRecords shortlists above the cutoff and merely scores below it", async () => {
  const client = new FakeScoringClient([
    '[{"id":"a","score":90,"confidence":"high","rationale":"Strong.","gaps":[]},' +
      '{"id":"b","score":40,"confidence":"medium","rationale":"Wrong level.","gaps":["People management"]}]',
  ]);

  const result = await scoreRecords([job("a"), job("b")], profile, prefs, client, new CostLedger("run-1", ledgerPath));

  assert.equal(result.scored.length, 2);
  assert.equal(result.scored.find((r) => r.id === "a")?.state, "shortlisted");
  assert.equal(result.scored.find((r) => r.id === "b")?.state, "scored");
  assert.deepEqual(result.scored.find((r) => r.id === "b")?.gaps, ["People management"]);
});

test("a failed batch is reported and its postings stay unscored rather than vanishing", async () => {
  const client = new FakeScoringClient(["this is not json"]);

  const result = await scoreRecords([job("a")], profile, prefs, client, new CostLedger("run-2", ledgerPath));

  assert.equal(result.scored.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0] ?? "", /not a JSON array/);
});

test("the cached system prefix is byte-identical across batches, so the cache can actually hit", async () => {
  const client = new FakeScoringClient([
    '[{"id":"a","score":70,"confidence":"high","rationale":"x","gaps":[]},{"id":"b","score":70,"confidence":"high","rationale":"x","gaps":[]}]',
    '[{"id":"c","score":70,"confidence":"high","rationale":"x","gaps":[]}]',
  ]);

  await scoreRecords([job("a"), job("b"), job("c")], profile, prefs, client, new CostLedger("run-3", ledgerPath));

  assert.equal(client.requests.length, 2);
  assert.equal(client.requests[0]?.system, client.requests[1]?.system);
});
