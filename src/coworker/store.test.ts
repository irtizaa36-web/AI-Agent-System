import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCoworkerTaskStore, JsonFileCoworkerTaskStore } from "./store";
import { createCoworkerTask } from "./task";

test("InMemoryCoworkerTaskStore round-trips tasks by id", async () => {
  const store = new InMemoryCoworkerTaskStore();
  const task = createCoworkerTask("do a thing", "macmini");
  await store.save(task);
  assert.deepEqual(await store.list(), [task]);
});

test("JsonFileCoworkerTaskStore lists an empty array when the directory doesn't exist yet", async () => {
  const store = new JsonFileCoworkerTaskStore(join(tmpdir(), "coworker-tasks-does-not-exist"));
  assert.deepEqual(await store.list(), []);
});

test("JsonFileCoworkerTaskStore persists one JSON file per task, readable back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coworker-tasks-"));
  try {
    const store = new JsonFileCoworkerTaskStore(dir);
    const a = createCoworkerTask("task a", "macmini");
    const b = createCoworkerTask("task b", "both");
    await store.save(a);
    await store.save(b);

    const listed = await store.list();
    assert.equal(listed.length, 2);
    assert.deepEqual(
      listed.find((t) => t.id === a.id),
      a,
    );
    assert.deepEqual(
      listed.find((t) => t.id === b.id),
      b,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
