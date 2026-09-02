import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryWorkflowStore, JsonFileWorkflowStore } from "./workflow-store";
import { createWorkflow } from "../core/workflow";

test("InMemoryWorkflowStore saves, loads, and lists workflows", async () => {
  const store = new InMemoryWorkflowStore();
  const workflow = createWorkflow("book a table", [{ agentName: "personal-admin", instructions: "draft an inquiry" }], "wf-1");
  await store.save(workflow);

  assert.equal((await store.load("wf-1"))?.goal, "book a table");
  assert.equal(await store.load("missing"), undefined);
  assert.equal((await store.list()).length, 1);
});

test("JsonFileWorkflowStore persists a workflow to disk and reads it back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchestrator-workflowstore-"));
  const store = new JsonFileWorkflowStore(dir);
  const workflow = createWorkflow("book a table", [{ agentName: "personal-admin", instructions: "draft an inquiry" }], "wf-1");

  try {
    await store.save(workflow);
    const loaded = await store.load("wf-1");

    assert.equal(loaded?.id, "wf-1");
    assert.equal(loaded?.goal, "book a table");
    assert.equal(loaded?.steps.length, 1);
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JsonFileWorkflowStore returns undefined/empty for a directory that doesn't exist yet", async () => {
  const dir = join(tmpdir(), "orchestrator-workflowstore-does-not-exist");
  const store = new JsonFileWorkflowStore(dir);

  assert.equal(await store.load("anything"), undefined);
  assert.deepEqual(await store.list(), []);
});
