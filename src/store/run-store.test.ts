import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryRunStore, JsonFileRunStore } from "./run-store";
import type { Run } from "../core/run";

function sampleRun(id: string): Run {
  return {
    id,
    task: { id: "task-1", instructions: "say hi" },
    agentName: "demo",
    status: "succeeded",
    session: { messages: [] },
    steps: [],
    result: { status: "succeeded", output: "hi!" },
  };
}

test("InMemoryRunStore saves, loads, and lists runs", async () => {
  const store = new InMemoryRunStore();
  await store.save(sampleRun("run-1"));

  assert.equal((await store.load("run-1"))?.result?.output, "hi!");
  assert.equal(await store.load("missing"), undefined);
  assert.equal((await store.list()).length, 1);
});

test("JsonFileRunStore persists a run to disk and reads it back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchestrator-runstore-"));
  const store = new JsonFileRunStore(dir);

  try {
    await store.save(sampleRun("run-1"));
    const loaded = await store.load("run-1");

    assert.equal(loaded?.id, "run-1");
    assert.equal(loaded?.result?.output, "hi!");
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JsonFileRunStore returns undefined/empty for a directory that doesn't exist yet", async () => {
  const dir = join(tmpdir(), "orchestrator-runstore-does-not-exist");
  const store = new JsonFileRunStore(dir);

  assert.equal(await store.load("anything"), undefined);
  assert.deepEqual(await store.list(), []);
});
