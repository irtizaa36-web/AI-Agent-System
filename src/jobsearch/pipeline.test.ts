import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPipeline } from "./pipeline";
import { renderDigest } from "./digest";
import { InMemoryJobStore } from "../store/job-store";
import { FakeScoringClient } from "./scoring-client";
import { DEFAULT_PREFERENCES, type Preferences, type RawPosting } from "./records";
import type { Source } from "./sources/source";

const LEDGER = join(tmpdir(), `pipeline-costs-${process.pid}.jsonl`);

function posting(overrides: Partial<RawPosting> = {}): RawPosting {
  return {
    sourceId: "greenhouse:acme",
    url: "https://a.test/jobs/1",
    title: "Marketing Manager",
    company: "Acme",
    location: "Remote - US",
    body: "<p>Own demand generation. Range $130,000 - $160,000.</p>",
    postedAt: "2026-09-01T00:00:00.000Z",
    fetchedAt: "2026-09-13T08:00:00.000Z",
    ...overrides,
  };
}

function source(id: string, postings: readonly RawPosting[]): Source {
  return { id, company: "Acme", fetch: async () => postings };
}

function brokenSource(id: string): Source {
  return {
    id,
    company: "Broken Co",
    fetch: async () => {
      throw new Error("HTTP 404 Not Found");
    },
  };
}

const prefs: Preferences = { ...DEFAULT_PREFERENCES, titles: ["marketing manager"], scoreCutoff: 65 };
const profile = { resume: "Ten years in demand generation.", notes: "" };

function scored(ids: readonly string[], score: number): FakeScoringClient {
  // The fake echoes whatever ids the pipeline generated; the test resolves
  // them from the store after the run instead of guessing UUIDs.
  void ids;
  return new FakeScoringClient([]);
}

test("a full run discovers, filters, scores and shortlists a matching role", async () => {
  const store = new InMemoryJobStore();

  // Score by responding to whatever ids the batch prompt actually contained.
  const client = new (class extends FakeScoringClient {
    constructor() {
      super([]);
    }
    async complete(request: Parameters<FakeScoringClient["complete"]>[0]) {
      this.requests.push(request);
      const ids = [...request.user.matchAll(/"id": "([^"]+)"/g)].map((match) => match[1]);
      const body = ids.map((id) => `{"id":"${id}","score":90,"confidence":"high","rationale":"Strong fit.","gaps":[]}`);
      return { text: `[${body.join(",")}]`, usage: { inputTokens: 1200, outputTokens: 200 } };
    }
  })();

  const summary = await runPipeline({
    sources: [source("greenhouse:acme", [posting()])],
    store,
    prefs,
    profile,
    scoringClient: client,
    costLogPath: LEDGER,
    politeDelay: false,
  });

  assert.equal(summary.fetchedCount, 1);
  assert.equal(summary.newCount, 1);
  assert.equal(summary.shortlisted.length, 1);
  assert.equal(summary.shortlisted[0]?.score, 90);
  assert.equal(summary.shortlisted[0]?.state, "shortlisted");
  assert.ok(summary.costUsd > 0, "the run records what it spent");
});

test("re-running finds nothing new and spends nothing — the run is idempotent", async () => {
  const store = new InMemoryJobStore();
  const deps = {
    sources: [source("greenhouse:acme", [posting()])],
    store,
    prefs,
    profile,
    scoringClient: new FakeScoringClient(['[]', '[]']),
    costLogPath: LEDGER,
    politeDelay: false,
  };

  await runPipeline(deps);
  const second = await runPipeline(deps);

  assert.equal(second.fetchedCount, 1, "it still fetched");
  assert.equal(second.newCount, 0, "but nothing was new");
  assert.equal(second.duplicateCount, 1);
  assert.equal(second.costUsd, 0, "and so it cost nothing");
});

test("a broken source degrades and is reported; the rest of the run completes", async () => {
  const store = new InMemoryJobStore();

  const summary = await runPipeline({
    sources: [brokenSource("greenhouse:broken"), source("greenhouse:acme", [posting()])],
    store,
    prefs,
    profile,
    scoringClient: new FakeScoringClient(["[]"]),
    costLogPath: LEDGER,
    politeDelay: false,
  });

  const broken = summary.health.find((entry) => entry.sourceId === "greenhouse:broken");
  assert.equal(broken?.state, "degraded");
  assert.match(broken?.error ?? "", /404/);
  assert.equal(summary.fetchedCount, 1, "the healthy source still delivered");

  assert.match(renderDigest(summary), /Sources needing attention/);
});

test("a non-remote role is filtered before any model call", async () => {
  const store = new InMemoryJobStore();
  const client = new FakeScoringClient(["[]"]);

  const summary = await runPipeline({
    sources: [source("greenhouse:acme", [posting({ location: "Chicago, IL", body: "<p>On-site role in our Chicago office.</p>" })])],
    store,
    prefs,
    profile,
    scoringClient: client,
    costLogPath: LEDGER,
    politeDelay: false,
  });

  assert.equal(summary.filteredCount, 1);
  assert.equal(client.requests.length, 0, "the model was never called");
  assert.equal(summary.costUsd, 0);
});

test("a remote role with no US option is filtered under usRemoteOnly, before any model call", async () => {
  const store = new InMemoryJobStore();
  const client = new FakeScoringClient(["[]"]);
  const usRemotePrefs: Preferences = { ...prefs, usRemoteOnly: true };

  const summary = await runPipeline({
    sources: [source("greenhouse:acme", [posting({ location: "Remote - India" })])],
    store,
    prefs: usRemotePrefs,
    profile,
    scoringClient: client,
    costLogPath: LEDGER,
    politeDelay: false,
  });

  assert.equal(summary.filteredCount, 1);
  assert.equal(client.requests.length, 0, "the model was never called");
});

test("a remote role that states a US option clears usRemoteOnly and reaches scoring", async () => {
  const store = new InMemoryJobStore();
  const usRemotePrefs: Preferences = { ...prefs, usRemoteOnly: true };

  const client = new (class extends FakeScoringClient {
    constructor() {
      super([]);
    }
    async complete(request: Parameters<FakeScoringClient["complete"]>[0]) {
      this.requests.push(request);
      const ids = [...request.user.matchAll(/"id": "([^"]+)"/g)].map((match) => match[1]);
      const body = ids.map((id) => `{"id":"${id}","score":90,"confidence":"high","rationale":"Good.","gaps":[]}`);
      return { text: `[${body.join(",")}]`, usage: { inputTokens: 800, outputTokens: 100 } };
    }
  })();

  const summary = await runPipeline({
    sources: [source("greenhouse:acme", [posting({ location: "Remote - US" })])],
    store,
    prefs: usRemotePrefs,
    profile,
    scoringClient: client,
    costLogPath: LEDGER,
    politeDelay: false,
  });

  assert.equal(summary.filteredCount, 0);
  assert.equal(summary.shortlisted.length, 1);
});

test("with no scoring client the run still discovers and says plainly why nothing was scored", async () => {
  const store = new InMemoryJobStore();

  const summary = await runPipeline({
    sources: [source("greenhouse:acme", [posting()])],
    store,
    prefs,
    profile,
    costLogPath: LEDGER,
    politeDelay: false,
  });

  assert.equal(summary.newCount, 1);
  assert.equal(summary.scoredCount, 0);
  assert.match(summary.failures[0] ?? "", /ANTHROPIC_API_KEY/);

  // The posting is saved, so the next run with a key picks it up.
  assert.equal((await store.listJobs()).length, 1);
});

test("the same role on two boards produces one shortlisted record with both links", async () => {
  const store = new InMemoryJobStore();

  const client = new (class extends FakeScoringClient {
    constructor() {
      super([]);
    }
    async complete(request: Parameters<FakeScoringClient["complete"]>[0]) {
      this.requests.push(request);
      const ids = [...request.user.matchAll(/"id": "([^"]+)"/g)].map((match) => match[1]);
      const body = ids.map((id) => `{"id":"${id}","score":88,"confidence":"high","rationale":"Good.","gaps":[]}`);
      return { text: `[${body.join(",")}]`, usage: { inputTokens: 1000, outputTokens: 150 } };
    }
  })();

  const summary = await runPipeline({
    sources: [
      source("greenhouse:acme", [posting()]),
      source("lever:acme", [posting({ sourceId: "lever:acme", url: "https://b.test/jobs/9", body: "<p>Own demand generation. Range $130,000 - $160,000.</p>" })]),
    ],
    store,
    prefs,
    profile,
    scoringClient: client,
    costLogPath: LEDGER,
    politeDelay: false,
  });

  assert.equal(summary.fetchedCount, 2, "two postings arrived");
  assert.equal(summary.shortlisted.length, 1, "one role reached the digest");
  assert.equal(summary.shortlisted[0]?.sources.length, 2, "carrying both apply links");
});

void scored;
