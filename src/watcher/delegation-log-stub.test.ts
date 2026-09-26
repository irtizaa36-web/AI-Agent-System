import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPickupStub, writePickupStub, DELEGATION_LOG_PATH } from "./delegation-log-stub";
import type { Brief } from "./brief";
import type { GitCommandResult, GitRunner } from "../integrations/git/auto-commit";

const brief: Brief = {
  title: "Fix the flaky sweep test",
  targetBranch: "claude/x-sweep-flake-fix",
  body: "Diagnose and fix the intermittent timeout.",
};

test("renderPickupStub includes the title, branch, source, brief body, and fill-in headings", () => {
  const stub = renderPickupStub(brief, "claude/briefs-drop", "docs/delegation/briefs/x-sweep.md", "2026-09-26T12:00:00.000Z");

  assert.match(stub, /# Delegation log: Fix the flaky sweep test/);
  assert.match(stub, /Branch: `claude\/x-sweep-flake-fix`/);
  assert.match(stub, /claude\/briefs-drop:docs\/delegation\/briefs\/x-sweep\.md/);
  assert.match(stub, /2026-09-26T12:00:00\.000Z/);
  assert.match(stub, /Diagnose and fix the intermittent timeout\./);
  assert.match(stub, /## Delegation table/);
  assert.match(stub, /## Budget status/);
});

test("renderPickupStub notes an empty body plainly instead of leaving a blank section", () => {
  const stub = renderPickupStub({ ...brief, body: "" }, "src", "path.md", "now");
  assert.match(stub, /_\(the brief had no body\)_/);
});

function ok(stdout = ""): GitCommandResult {
  return { status: 0, stdout, stderr: "" };
}
function fail(stderr: string): GitCommandResult {
  return { status: 1, stdout: "", stderr };
}

test("writePickupStub writes the file to disk and commits+pushes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pickup-stub-"));
  try {
    const calls: (readonly string[])[] = [];
    const runner: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === "diff") return fail(""); // has changes
      return ok();
    };

    const result = await writePickupStub(brief, "claude/briefs-drop", "docs/delegation/briefs/x.md", dir, runner, () => "2026-09-26T00:00:00.000Z");

    assert.equal(result.committed, true);
    assert.equal(result.pushed, true);
    const written = await readFile(join(dir, DELEGATION_LOG_PATH), "utf-8");
    assert.match(written, /Fix the flaky sweep test/);
    assert.deepEqual(calls.map((c) => c[0]), ["add", "diff", "commit", "push"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writePickupStub reports a git failure without throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pickup-stub-"));
  try {
    const runner: GitRunner = (args) => (args[0] === "add" ? fail("fatal: not a git repository") : ok());
    const result = await writePickupStub(brief, "src-branch", "path.md", dir, runner);
    assert.equal(result.committed, false);
    assert.match(result.error ?? "", /fatal: not a git repository/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
