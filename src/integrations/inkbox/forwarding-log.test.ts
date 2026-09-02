import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryForwardingLog } from "./forwarding-log";

test("hasForwarded is false until a successful forward is recorded", async () => {
  const log = new InMemoryForwardingLog();
  assert.equal(await log.hasForwarded("m1"), false);

  await log.record({ messageId: "m1", forwardedTo: "owner@example.com", status: "forwarded", occurredAt: new Date().toISOString() });

  assert.equal(await log.hasForwarded("m1"), true);
});

test("a failed forward attempt does not count as forwarded, so it can be retried", async () => {
  const log = new InMemoryForwardingLog();
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
