import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryMessageEventLog, JsonFileMessageEventLog } from "./message-event-log";
import type { MessageEventLog } from "./message-event-log";

async function withEachLog(fn: (log: MessageEventLog) => Promise<void>): Promise<void> {
  await fn(new InMemoryMessageEventLog());

  const dir = await mkdtemp(join(tmpdir(), "orchestrator-message-events-"));
  try {
    await fn(new JsonFileMessageEventLog(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("list is empty before anything is recorded", async () => {
  await withEachLog(async (log) => {
    assert.deepEqual(await log.list(), []);
  });
});

test("record persists an entry that list() reports back", async () => {
  await withEachLog(async (log) => {
    await log.record({ messageId: "m1", event: "sent", occurredAt: "2026-01-01T00:00:00.000Z" });
    const all = await log.list();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.messageId, "m1");
    assert.equal(all[0]?.event, "sent");
  });
});

test("a message id can accumulate multiple distinct lifecycle events without overwriting each other", async () => {
  await withEachLog(async (log) => {
    await log.record({ messageId: "m1", event: "sent", occurredAt: "2026-01-01T00:00:00.000Z" });
    await log.record({ messageId: "m1", event: "delivered", occurredAt: "2026-01-01T00:00:05.000Z" });
    const all = await log.list();
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((r) => r.event).sort(),
      ["delivered", "sent"],
    );
  });
});

test("bounced/failed events keep their detail text", async () => {
  await withEachLog(async (log) => {
    await log.record({ messageId: "m2", event: "bounced", detail: "mailbox full", occurredAt: "2026-01-01T00:00:00.000Z" });
    const [record] = await log.list();
    assert.equal(record?.detail, "mailbox full");
  });
});

test("JsonFileMessageEventLog survives being recreated against the same directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchestrator-message-events-restart-"));
  try {
    const first = new JsonFileMessageEventLog(dir);
    await first.record({ messageId: "m1", event: "sent", occurredAt: "2026-01-01T00:00:00.000Z" });

    const second = new JsonFileMessageEventLog(dir);
    const all = await second.list();
    assert.equal(all.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
