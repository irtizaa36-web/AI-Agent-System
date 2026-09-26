import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeGitHubClient } from "./fake-client";

test("listBranches filters by prefix", async () => {
  const client = new FakeGitHubClient();
  client.seedBranch("claude/one");
  client.seedBranch("claude/two");
  client.seedBranch("main");

  const branches = await client.listBranches("claude/");
  assert.deepEqual([...branches].sort(), ["claude/one", "claude/two"]);
});

test("listDirectory returns only direct children of the path, not nested files", async () => {
  const client = new FakeGitHubClient();
  client.seedFile("claude/one", "docs/delegation/briefs/a.md", "a");
  client.seedFile("claude/one", "docs/delegation/briefs/nested/b.md", "b");
  client.seedFile("claude/one", "docs/delegation/other.md", "c");

  const entries = await client.listDirectory("claude/one", "docs/delegation/briefs");
  assert.deepEqual(entries.map((e) => e.name), ["a.md"]);
});

test("listDirectory returns an empty array for a branch or path that doesn't exist", async () => {
  const client = new FakeGitHubClient();
  client.seedBranch("claude/one");
  assert.deepEqual(await client.listDirectory("claude/one", "docs/delegation/briefs"), []);
  assert.deepEqual(await client.listDirectory("no-such-branch", "docs/delegation/briefs"), []);
});

test("getFileContent returns undefined for a missing file rather than throwing", async () => {
  const client = new FakeGitHubClient();
  client.seedBranch("claude/one");
  assert.equal(await client.getFileContent("claude/one", "docs/delegation/briefs/a.md"), undefined);
});

test("re-seeding a path with new content mints a new sha, so the watcher can tell it changed", async () => {
  const client = new FakeGitHubClient();
  client.seedFile("claude/one", "docs/delegation/briefs/a.md", "v1");
  const [first] = await client.listDirectory("claude/one", "docs/delegation/briefs");

  client.seedFile("claude/one", "docs/delegation/briefs/a.md", "v2");
  const [second] = await client.listDirectory("claude/one", "docs/delegation/briefs");

  assert.notEqual(first.sha, second.sha);
  assert.equal(await client.getFileContent("claude/one", "docs/delegation/briefs/a.md"), "v2");
});
