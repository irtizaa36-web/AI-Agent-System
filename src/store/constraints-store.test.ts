import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryConstraintsStore, JsonFileConstraintsStore, formatConstraintsForPrompt } from "./constraints-store";

test("InMemoryConstraintsStore.add records a constraint with a timestamp, in order", async () => {
  const store = new InMemoryConstraintsStore();

  const first = await store.add("Press releases are not independent sources.");
  const second = await store.add("Subsidiaries roll up to the parent node.");

  assert.deepEqual(await store.list(), [first, second]);
  assert.equal(first.text, "Press releases are not independent sources.");
  assert.ok(first.recordedAt);
});

test("formatConstraintsForPrompt returns an empty string for no constraints", () => {
  assert.equal(formatConstraintsForPrompt([]), "");
});

test("formatConstraintsForPrompt renders each constraint with its date", () => {
  const block = formatConstraintsForPrompt([
    { id: "1", text: "Never average conflicting numbers.", recordedAt: "2026-08-29T00:00:00.000Z" },
  ]);

  assert.match(block, /Corrections learned from past runs/);
  assert.match(block, /\(2026-08-29\) Never average conflicting numbers\./);
});

test("JsonFileConstraintsStore persists across separate instances against the same file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "constraints-store-test-"));
  const path = join(dir, "constraints.json");
  try {
    const first = new JsonFileConstraintsStore(path);
    await first.add("First correction.");

    const second = new JsonFileConstraintsStore(path);
    await second.add("Second correction.");

    const all = await second.list();
    assert.equal(all.length, 2);
    assert.equal(all[0].text, "First correction.");
    assert.equal(all[1].text, "Second correction.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JsonFileConstraintsStore.list returns an empty array before the file exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "constraints-store-test-"));
  const path = join(dir, "missing.json");
  try {
    const store = new JsonFileConstraintsStore(path);
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
