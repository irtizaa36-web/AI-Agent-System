import { test } from "node:test";
import assert from "node:assert/strict";
import { pollForBriefs, type BriefWatcherDeps, type CheckoutOutcome, type RecordPickupOutcome } from "./brief-watcher";
import { FakeGitHubClient } from "../integrations/github/fake-client";
import { InMemorySeenBriefStore } from "./seen-store";
import type { Brief } from "./brief";

const VALID_BRIEF = ["# Fix the thing", "", "Target branch: `claude/fix-the-thing`", "", "Do the fix.", ""].join("\n");

function makeDeps(github: FakeGitHubClient, overrides: Partial<BriefWatcherDeps> = {}): BriefWatcherDeps {
  return {
    github,
    seenStore: new InMemorySeenBriefStore(),
    checkoutBranch: async (): Promise<CheckoutOutcome> => ({ ok: true }),
    recordPickup: async (): Promise<RecordPickupOutcome> => ({ ok: true }),
    ...overrides,
  };
}

test("finds a new brief on a claude/* branch, checks it out, and records the pickup", async () => {
  const github = new FakeGitHubClient();
  github.seedFile("claude/briefs-drop", "docs/delegation/briefs/fix-the-thing.md", VALID_BRIEF);
  const checkedOutBranches: string[] = [];
  const deps = makeDeps(github, {
    checkoutBranch: async (branch) => {
      checkedOutBranches.push(branch);
      return { ok: true };
    },
  });

  const result = await pollForBriefs(deps);

  assert.deepEqual(result.scannedBranches, ["claude/briefs-drop"]);
  assert.equal(result.pickups.length, 1);
  assert.equal(result.pickups[0].brief.targetBranch, "claude/fix-the-thing");
  assert.equal(result.pickups[0].checkedOut, true);
  assert.equal(result.pickups[0].logWritten, true);
  assert.deepEqual(checkedOutBranches, ["claude/fix-the-thing"]);
  assert.equal(result.parseErrors.length, 0);
});

test("never re-picks up a brief it has already seen", async () => {
  const github = new FakeGitHubClient();
  github.seedFile("claude/briefs-drop", "docs/delegation/briefs/fix-the-thing.md", VALID_BRIEF);
  let checkoutCount = 0;
  const deps = makeDeps(github, {
    checkoutBranch: async () => {
      checkoutCount++;
      return { ok: true };
    },
  });

  const first = await pollForBriefs(deps);
  const second = await pollForBriefs(deps);

  assert.equal(first.pickups.length, 1);
  assert.equal(second.pickups.length, 0);
  assert.equal(checkoutCount, 1);
});

test("re-picks up a brief whose content changed (new sha), even though the path is the same", async () => {
  const github = new FakeGitHubClient();
  github.seedFile("claude/briefs-drop", "docs/delegation/briefs/fix-the-thing.md", VALID_BRIEF);
  const deps = makeDeps(github);

  await pollForBriefs(deps);
  github.seedFile("claude/briefs-drop", "docs/delegation/briefs/fix-the-thing.md", VALID_BRIEF.replace("Do the fix.", "Do the fix, v2."));
  const second = await pollForBriefs(deps);

  assert.equal(second.pickups.length, 1);
  assert.match(second.pickups[0].brief.body, /v2/);
});

test("ignores non-markdown files in the briefs directory", async () => {
  const github = new FakeGitHubClient();
  github.seedFile("claude/briefs-drop", "docs/delegation/briefs/README.txt", "not a brief");
  const result = await pollForBriefs(makeDeps(github));
  assert.equal(result.pickups.length, 0);
  assert.equal(result.parseErrors.length, 0);
});

test("ignores branches with no briefs directory at all", async () => {
  const github = new FakeGitHubClient();
  github.seedBranch("claude/no-briefs-here");
  const result = await pollForBriefs(makeDeps(github));
  assert.deepEqual(result.scannedBranches, ["claude/no-briefs-here"]);
  assert.equal(result.pickups.length, 0);
});

test("records a malformed brief as a parse error, without checking anything out, and doesn't re-report it", async () => {
  const github = new FakeGitHubClient();
  github.seedFile("claude/briefs-drop", "docs/delegation/briefs/bad.md", "no title, no target branch");
  let checkoutCalled = false;
  const deps = makeDeps(github, { checkoutBranch: async () => { checkoutCalled = true; return { ok: true }; } });

  const first = await pollForBriefs(deps);
  const second = await pollForBriefs(deps);

  assert.equal(first.parseErrors.length, 1);
  assert.match(first.parseErrors[0].error, /missing title/);
  assert.equal(checkoutCalled, false);
  assert.equal(second.parseErrors.length, 0, "the same malformed content isn't re-reported on the next poll");
});

test("reports a checkout failure without marking the brief seen, so it's retried next poll", async () => {
  const github = new FakeGitHubClient();
  github.seedFile("claude/briefs-drop", "docs/delegation/briefs/fix-the-thing.md", VALID_BRIEF);
  let attempts = 0;
  const deps = makeDeps(github, {
    checkoutBranch: async () => {
      attempts++;
      return attempts === 1 ? { ok: false, error: "git fetch failed: network blip" } : { ok: true };
    },
  });

  const first = await pollForBriefs(deps);
  assert.equal(first.pickups.length, 1);
  assert.equal(first.pickups[0].checkedOut, false);
  assert.match(first.pickups[0].error ?? "", /network blip/);

  const second = await pollForBriefs(deps);
  assert.equal(second.pickups.length, 1);
  assert.equal(second.pickups[0].checkedOut, true, "a retried poll succeeds once the transient failure clears");
});

test("still marks a brief seen when checkout succeeds but writing the delegation-log stub fails", async () => {
  const github = new FakeGitHubClient();
  github.seedFile("claude/briefs-drop", "docs/delegation/briefs/fix-the-thing.md", VALID_BRIEF);
  const deps = makeDeps(github, { recordPickup: async () => ({ ok: false, error: "push failed" }) });

  const result = await pollForBriefs(deps);

  assert.equal(result.pickups[0].checkedOut, true);
  assert.equal(result.pickups[0].logWritten, false);
  assert.equal(result.pickups[0].error, "push failed");
});

test("processes multiple new briefs across multiple branches in one poll", async () => {
  const github = new FakeGitHubClient();
  github.seedFile("claude/briefs-drop-1", "docs/delegation/briefs/a.md", VALID_BRIEF);
  github.seedFile(
    "claude/briefs-drop-2",
    "docs/delegation/briefs/b.md",
    ["# Second task", "", "Target branch: `claude/second-task`", "", "Body two."].join("\n"),
  );

  const result = await pollForBriefs(makeDeps(github));

  assert.equal(result.scannedBranches.length, 2);
  assert.equal(result.pickups.length, 2);
  assert.deepEqual(
    result.pickups.map((p) => p.brief.targetBranch).sort(),
    ["claude/fix-the-thing", "claude/second-task"],
  );
});

test("only scans branches matching the configured prefix", async () => {
  const github = new FakeGitHubClient();
  github.seedFile("main", "docs/delegation/briefs/a.md", VALID_BRIEF);
  const result = await pollForBriefs(makeDeps(github));
  assert.deepEqual(result.scannedBranches, []);
  assert.equal(result.pickups.length, 0);
});
