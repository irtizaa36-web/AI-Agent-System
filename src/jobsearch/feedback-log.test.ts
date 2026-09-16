import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryFeedbackLog, JsonFileFeedbackLog } from "./feedback-log";
import type { FeedbackLog } from "./feedback-log";

async function withEachLog(fn: (log: FeedbackLog) => Promise<void>): Promise<void> {
  await fn(new InMemoryFeedbackLog());

  const dir = await mkdtemp(join(tmpdir(), "jobsearch-feedback-log-"));
  try {
    await fn(new JsonFileFeedbackLog(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function record(overrides: Partial<Parameters<FeedbackLog["record"]>[0]> = {}) {
  return {
    messageId: "m1",
    fromAddress: "brshivani@gmail.com",
    processedAt: new Date().toISOString(),
    appliedFields: [],
    hadQuestion: false,
    replied: false,
    ...overrides,
  };
}

test("hasProcessed is false until a message is recorded", async () => {
  await withEachLog(async (log) => {
    assert.equal(await log.hasProcessed("m1"), false);
    await log.record(record());
    assert.equal(await log.hasProcessed("m1"), true);
  });
});

test("a message with no question and no applied fields still counts as processed once recorded — reprocessing is what this log exists to prevent, not just tracking successes", async () => {
  await withEachLog(async (log) => {
    await log.record(record({ appliedFields: [], hadQuestion: false, replied: false }));
    assert.equal(await log.hasProcessed("m1"), true);
  });
});

test("list returns every recorded message", async () => {
  await withEachLog(async (log) => {
    await log.record(record({ messageId: "m1" }));
    await log.record(record({ messageId: "m2", appliedFields: ["salaryFloor"], hadQuestion: true, replied: true }));
    const all = await log.list();
    assert.equal(all.length, 2);
    assert.ok(all.some((r) => r.messageId === "m2" && r.appliedFields.includes("salaryFloor")));
  });
});

test("JsonFileFeedbackLog survives being recreated against the same directory (process-restart parity)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jobsearch-feedback-log-restart-"));
  try {
    const first = new JsonFileFeedbackLog(dir);
    await first.record(record({ messageId: "m1" }));

    const second = new JsonFileFeedbackLog(dir);
    assert.equal(await second.hasProcessed("m1"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JsonFileFeedbackLog.list returns an empty array rather than throwing when the directory doesn't exist yet", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "jobsearch-feedback-log-")), "never-created");
  const log = new JsonFileFeedbackLog(dir);
  assert.deepEqual(await log.list(), []);
});
