import { test } from "node:test";
import assert from "node:assert/strict";
import { runWatchBriefsCommand, runLoop } from "./watch-briefs-commands";

function collectingDeps(cwd = "/repo") {
  const out: string[] = [];
  const err: string[] = [];
  return { deps: { cwd, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) }, out, err };
}

test("an unknown subcommand prints usage and fails", async () => {
  const { deps, err } = collectingDeps();
  const code = await runWatchBriefsCommand(["bogus"], deps);
  assert.equal(code, 1);
  assert.match(err.join("\n"), /Usage: orchestrator watch-briefs/);
});

test("poll fails cleanly with a clear message when GITHUB_TOKEN is unset", async () => {
  const previous = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const { deps, err } = collectingDeps();
    const code = await runWatchBriefsCommand(["poll"], deps);
    assert.equal(code, 1);
    assert.match(err.join("\n"), /GITHUB_TOKEN/);
  } finally {
    if (previous !== undefined) process.env.GITHUB_TOKEN = previous;
  }
});

test("runLoop polls once immediately, then waits intervalMs between each subsequent poll, for the given number of iterations", async () => {
  const pollCalls: number[] = [];
  const sleeps: number[] = [];
  let poll = async () => {
    pollCalls.push(Date.now());
    return 0;
  };

  await runLoop(() => poll(), 500, async (ms) => { sleeps.push(ms); }, () => {}, 3);

  assert.equal(pollCalls.length, 3);
  assert.deepEqual(sleeps, [500, 500]);
});

test("runLoop keeps going after a poll rejects, logging the failure instead of throwing", async () => {
  let call = 0;
  const logs: string[] = [];
  const poll = async () => {
    call++;
    if (call === 1) throw new Error("boom");
    return 0;
  };

  await runLoop(poll, 10, async () => {}, (line) => logs.push(line), 2);

  assert.equal(call, 2);
  assert.match(logs.join("\n"), /boom/);
});
