import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDraftStore, JsonFileDraftStore } from "./draft-store";
import type { DraftStore } from "./draft-store";

function baseInput() {
  return { to: [{ address: "restaurant@example.com" }], subject: "Table for 4", body: "Hi there" };
}

async function withEachStore(fn: (store: DraftStore) => Promise<void>): Promise<void> {
  await fn(new InMemoryDraftStore());

  const dir = await mkdtemp(join(tmpdir(), "orchestrator-draft-store-"));
  try {
    await fn(new JsonFileDraftStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("save creates a new draft with revision rev-1", async () => {
  await withEachStore(async (store) => {
    const draft = await store.save(baseInput());
    assert.equal(draft.revision, "rev-1");
    assert.equal(draft.subject, "Table for 4");
  });
});

test("saving again under the same draftId bumps the revision", async () => {
  await withEachStore(async (store) => {
    const first = await store.save(baseInput());
    const second = await store.save({ ...baseInput(), body: "Updated body", draftId: first.id });
    assert.equal(second.id, first.id);
    assert.equal(second.revision, "rev-2");
    assert.equal(second.body, "Updated body");
  });
});

test("get returns undefined for an unknown draft id", async () => {
  await withEachStore(async (store) => {
    assert.equal(await store.get("no-such-draft"), undefined);
  });
});

test("get reads back exactly what was saved, including the current revision", async () => {
  await withEachStore(async (store) => {
    const saved = await store.save(baseInput());
    const fetched = await store.get(saved.id);
    assert.deepEqual(fetched, saved);
  });
});

test("JsonFileDraftStore survives being recreated against the same directory (process-restart parity)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchestrator-draft-store-restart-"));
  try {
    const first = new JsonFileDraftStore(dir);
    const draft = await first.save(baseInput());

    const second = new JsonFileDraftStore(dir);
    const fetched = await second.get(draft.id);
    assert.deepEqual(fetched, draft);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
