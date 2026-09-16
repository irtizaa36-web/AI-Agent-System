import { test } from "node:test";
import assert from "node:assert/strict";
import { commitAndPush, type GitCommandResult, type GitRunner } from "./auto-commit";

function ok(stdout = ""): GitCommandResult {
  return { status: 0, stdout, stderr: "" };
}
function fail(stderr: string, status = 1): GitCommandResult {
  return { status, stdout: "", stderr };
}

/** Records every invocation and answers from a scripted map keyed by the git subcommand. */
function scriptedRunner(answers: Readonly<Record<string, GitCommandResult>>): { runner: GitRunner; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const runner: GitRunner = (args) => {
    calls.push(args);
    return answers[args[0] as string] ?? ok();
  };
  return { runner, calls };
}

test("commitAndPush stages, commits, and pushes exactly the one file, in order", () => {
  const { runner, calls } = scriptedRunner({ add: ok(), diff: fail("", 1), commit: ok(), push: ok() });
  const result = commitAndPush("config/job-search/shivani/preferences.json", "feedback: bump salary floor", "/repo", runner);

  assert.deepEqual(result, { committed: true, pushed: true });
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["add", "diff", "commit", "push"],
  );
  assert.deepEqual(calls[0], ["add", "config/job-search/shivani/preferences.json"]);
  assert.deepEqual(calls[2], ["commit", "-m", "feedback: bump salary floor", "--", "config/job-search/shivani/preferences.json"]);
});

test("commitAndPush does nothing and reports noChange when the patch didn't actually change the file", () => {
  const { runner, calls } = scriptedRunner({ add: ok(), diff: ok() }); // diff exit 0 == nothing staged
  const result = commitAndPush("prefs.json", "no-op patch", "/repo", runner);

  assert.deepEqual(result, { committed: false, pushed: false, noChange: true });
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["add", "diff"],
    "never reaches commit or push for a no-op change",
  );
});

test("commitAndPush stops and reports the error when git add fails, without attempting commit or push", () => {
  const { runner, calls } = scriptedRunner({ add: fail("fatal: not a git repository") });
  const result = commitAndPush("prefs.json", "msg", "/repo", runner);

  assert.equal(result.committed, false);
  assert.equal(result.pushed, false);
  assert.match(result.error ?? "", /fatal: not a git repository/);
  assert.deepEqual(calls.map((c) => c[0]), ["add"]);
});

test("commitAndPush reports a commit failure without attempting to push", () => {
  const { runner, calls } = scriptedRunner({ add: ok(), diff: fail("", 1), commit: fail("commit hook rejected") });
  const result = commitAndPush("prefs.json", "msg", "/repo", runner);

  assert.deepEqual(result, { committed: false, pushed: false, error: "git commit failed: commit hook rejected" });
  assert.deepEqual(calls.map((c) => c[0]), ["add", "diff", "commit"]);
});

test("commitAndPush reports committed:true, pushed:false when the commit succeeds but the push fails", () => {
  const { runner } = scriptedRunner({ add: ok(), diff: fail("", 1), commit: ok(), push: fail("could not resolve host") });
  const result = commitAndPush("prefs.json", "msg", "/repo", runner);

  assert.equal(result.committed, true);
  assert.equal(result.pushed, false);
  assert.match(result.error ?? "", /could not resolve host/);
});

test("commitAndPush passes the working directory through to every git invocation", () => {
  const seenCwds: string[] = [];
  const runner: GitRunner = (args, cwd) => {
    seenCwds.push(cwd);
    return args[0] === "diff" ? fail("", 1) : ok();
  };
  commitAndPush("prefs.json", "msg", "/some/repo/path", runner);
  assert.ok(seenCwds.every((cwd) => cwd === "/some/repo/path"));
});
