import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareWorkingBranch } from "./checkout";
import type { GitCommandResult, GitRunner } from "../integrations/git/auto-commit";

function ok(stdout = ""): GitCommandResult {
  return { status: 0, stdout, stderr: "" };
}
function fail(stderr: string, status = 1): GitCommandResult {
  return { status, stdout: "", stderr };
}

function scriptedRunner(answers: Readonly<Record<string, GitCommandResult>>): { runner: GitRunner; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const runner: GitRunner = (args) => {
    calls.push(args);
    return answers[args.join(" ")] ?? ok();
  };
  return { runner, calls };
}

test("creates a fresh branch off the base when the target doesn't exist on origin", () => {
  const { runner, calls } = scriptedRunner({
    "fetch origin main": ok(),
    "fetch origin claude/new-task": fail("fatal: couldn't find remote ref claude/new-task"),
    "checkout -B claude/new-task origin/main": ok(),
  });

  const result = prepareWorkingBranch("claude/new-task", "main", "/repo", runner);

  assert.deepEqual(result, { ok: true, branch: "claude/new-task", createdNew: true });
  assert.deepEqual(
    calls.map((c) => c.join(" ")),
    ["fetch origin main", "fetch origin claude/new-task", "checkout -B claude/new-task origin/main"],
  );
});

test("checks out the existing branch as-is when it already exists on origin", () => {
  const { runner } = scriptedRunner({
    "fetch origin main": ok(),
    "fetch origin claude/already-there": ok(),
    "checkout -B claude/already-there origin/claude/already-there": ok(),
  });

  const result = prepareWorkingBranch("claude/already-there", "main", "/repo", runner);

  assert.deepEqual(result, { ok: true, branch: "claude/already-there", createdNew: false });
});

test("reports an error and stops when fetching the base branch fails", () => {
  const { runner, calls } = scriptedRunner({ "fetch origin main": fail("could not resolve host") });

  const result = prepareWorkingBranch("claude/new-task", "main", "/repo", runner);

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /could not resolve host/);
  assert.deepEqual(calls.map((c) => c.join(" ")), ["fetch origin main"]);
});

test("reports an error when the final checkout fails", () => {
  const { runner } = scriptedRunner({
    "fetch origin main": ok(),
    "fetch origin claude/new-task": fail(""),
    "checkout -B claude/new-task origin/main": fail("local changes would be overwritten"),
  });

  const result = prepareWorkingBranch("claude/new-task", "main", "/repo", runner);

  assert.equal(result.ok, false);
  assert.equal(result.createdNew, true);
  assert.match(result.error ?? "", /local changes would be overwritten/);
});
