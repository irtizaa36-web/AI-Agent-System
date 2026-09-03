import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAgentStatusStore, JsonFileAgentStatusStore } from "./agent-status-store";
import { createAgentStatus } from "./agent-status";

test("InMemoryAgentStatusStore keeps only the latest status per agent name", async () => {
  const store = new InMemoryAgentStatusStore();
  await store.save(createAgentStatus("macmini", "idle"));
  await store.save(createAgentStatus("macmini", "working", "task-1"));
  const statuses = await store.list();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]?.status, "working");
});

test("JsonFileAgentStatusStore lists an empty array when the directory doesn't exist yet", async () => {
  const store = new JsonFileAgentStatusStore(join(tmpdir(), "agent-status-does-not-exist"));
  assert.deepEqual(await store.list(), []);
});

test("JsonFileAgentStatusStore persists one JSON file per agent, overwritten on the next save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-status-"));
  try {
    const store = new JsonFileAgentStatusStore(dir);
    await store.save(createAgentStatus("macmini", "idle"));
    await store.save(createAgentStatus("Laptop2", "working", "task-2"));
    await store.save(createAgentStatus("macmini", "stuck", "task-3"));

    const listed = await store.list();
    assert.equal(listed.length, 2);
    assert.equal(listed.find((s) => s.name === "macmini")?.status, "stuck");
    assert.equal(listed.find((s) => s.name === "Laptop2")?.status, "working");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
