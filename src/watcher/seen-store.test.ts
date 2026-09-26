import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySeenBriefStore, JsonFileSeenBriefStore, briefSeenKey } from "./seen-store";

test("briefSeenKey changes when the sha changes, so an edited brief is not treated as already seen", () => {
  const a = briefSeenKey("claude/foo", "docs/delegation/briefs/x.md", "sha1");
  const b = briefSeenKey("claude/foo", "docs/delegation/briefs/x.md", "sha2");
  assert.notEqual(a, b);
});

test("InMemorySeenBriefStore reports unseen until marked", async () => {
  const store = new InMemorySeenBriefStore();
  const key = briefSeenKey("claude/foo", "a.md", "sha1");
  assert.equal(await store.has(key), false);
  await store.markSeen(key);
  assert.equal(await store.has(key), true);
});

test("JsonFileSeenBriefStore persists across instances pointed at the same directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seen-store-"));
  try {
    const key = briefSeenKey("claude/foo", "docs/delegation/briefs/a.md", "sha1");
    const first = new JsonFileSeenBriefStore(dir);
    assert.equal(await first.has(key), false);
    await first.markSeen(key);

    const second = new JsonFileSeenBriefStore(dir);
    assert.equal(await second.has(key), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JsonFileSeenBriefStore never seen a key it wasn't given, even in a fresh empty directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seen-store-"));
  try {
    const store = new JsonFileSeenBriefStore(dir);
    assert.equal(await store.has(briefSeenKey("claude/foo", "a.md", "sha1")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
