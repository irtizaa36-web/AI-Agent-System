import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryForwardingLog, JsonFileForwardingLog } from "./forwarding-log";
import type { ForwardingLog } from "./forwarding-log";

async function withEachLog(fn: (log: ForwardingLog) => Promise<void>): Promise<void> {
  await fn(new InMemoryForwardingLog());

  const dir = await mkdtemp(join(tmpdir(), "orchestrator-forwarding-log-"));
  try {
    await fn(new JsonFileForwardingLog(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("hasForwarded is false until a successful forward is recorded", async () => {
  await withEachLog(async (log) => {
    assert.equal(await log.hasForwarded("m1"), false);

    await log.record({ messageId: "m1", forwardedTo: "owner@example.com", status: "forwarded", occurredAt: new Date().toISOString() });

    assert.equal(await log.hasForwarded("m1"), true);
  });
});

test("a failed forward attempt does not count as forwarded, so it can be retried", async () => {
  await withEachLog(async (log) => {
    await log.record({
      messageId: "m1",
      forwardedTo: "owner@example.com",
      status: "failed",
      reason: "simulated failure",
      occurredAt: new Date().toISOString(),
    });

    assert.equal(await log.hasForwarded("m1"), false);
    assert.equal((await log.list()).length, 1);
  });
});

test("JsonFileForwardingLog survives being recreated against the same directory (process-restart parity)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchestrator-forwarding-log-restart-"));
  try {
    const first = new JsonFileForwardingLog(dir);
    await first.record({ messageId: "m1", forwardedTo: "owner@example.com", status: "forwarded", occurredAt: new Date().toISOString() });

    const second = new JsonFileForwardingLog(dir);
    assert.equal(await second.hasForwarded("m1"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
