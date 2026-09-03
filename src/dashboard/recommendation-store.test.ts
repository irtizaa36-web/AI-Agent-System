import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryRecommendationStore, JsonFileRecommendationStore } from "./recommendation-store";
import { createRecommendation, withImplemented } from "./recommendation";

test("JsonFileRecommendationStore lists an empty array when the directory doesn't exist yet", async () => {
  const store = new JsonFileRecommendationStore(join(tmpdir(), "recommendations-does-not-exist"));
  assert.deepEqual(await store.list(), []);
});

test("JsonFileRecommendationStore persists one file per recommendation and reflects updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recommendations-"));
  try {
    const store = new JsonFileRecommendationStore(dir);
    const r = createRecommendation("dashboard", "add a filter");
    await store.save(r);
    await store.save(withImplemented(r, "added it"));

    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.implemented, true);
    assert.equal(listed[0]?.details, "added it");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("InMemoryRecommendationStore round-trips by id", async () => {
  const store = new InMemoryRecommendationStore();
  const r = createRecommendation("system", "fix the recipe");
  await store.save(r);
  assert.deepEqual(await store.list(), [r]);
});
