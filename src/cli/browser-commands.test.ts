import { test } from "node:test";
import assert from "node:assert/strict";
import { runBrowserCommand } from "./browser-commands";
import { FakeBrowserClient } from "../integrations/browser/fake-client";
import type { CliDeps } from "./index";

function fakeDeps(): { deps: CliDeps; stdoutLines: string[]; stderrLines: string[] } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const deps = { stdout: (l: string) => stdoutLines.push(l), stderr: (l: string) => stderrLines.push(l) } as unknown as CliDeps;
  return { deps, stdoutLines, stderrLines };
}

const URL = "https://x.com/home";

test("orchestrator browser health exits 0 and prints status ok for a real page", async () => {
  const { deps, stdoutLines } = fakeDeps();
  const client = new FakeBrowserClient("x", new Map([[URL, "Home  For you  Following  ".repeat(20)]]));
  const code = await runBrowserCommand(["health", "x", URL], deps, () => client);
  assert.equal(code, 0);
  assert.equal(stdoutLines[0], "status: ok");
});

test("orchestrator browser health exits non-zero and prints status blocked for a blank page", async () => {
  const { deps, stdoutLines } = fakeDeps();
  const client = new FakeBrowserClient("x", new Map([[URL, ""]]));
  const code = await runBrowserCommand(["health", "x", URL], deps, () => client);
  assert.equal(code, 1);
  assert.equal(stdoutLines[0], "status: blocked");
  assert.equal(client.requestedUrls.length, 1, "a health check is one request, no retry");
});

test("orchestrator browser health exits non-zero on a load error", async () => {
  const { deps, stdoutLines } = fakeDeps();
  const code = await runBrowserCommand(["health", "x", URL], deps, () => new FakeBrowserClient("x"));
  assert.equal(code, 1);
  assert.equal(stdoutLines[0], "status: error");
});

test("orchestrator browser health with missing args prints usage and exits 1", async () => {
  const { deps, stderrLines } = fakeDeps();
  const code = await runBrowserCommand(["health", "x"], deps, () => new FakeBrowserClient("x"));
  assert.equal(code, 1);
  assert.match(stderrLines.join("\n"), /Usage: orchestrator browser health <site> <url>/);
});
