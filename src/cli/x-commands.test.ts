import { test } from "node:test";
import assert from "node:assert/strict";
import { runXCommand } from "./x-commands";
import { FakeBrowserClient } from "../integrations/browser/fake-client";
import { STANDING_X_TOPICS, xSearchUrl } from "../integrations/x-research/topics";
import type { CliDeps } from "./index";

const noopSleep = async (): Promise<void> => {};

function fakeDeps(): { deps: CliDeps; stdoutLines: string[]; stderrLines: string[] } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const deps = {
    stdout: (line: string) => stdoutLines.push(line),
    stderr: (line: string) => stderrLines.push(line),
  } as unknown as CliDeps;
  return { deps, stdoutLines, stderrLines };
}

test("orchestrator x search-sweep exits 0 and prints a section per topic when the session is healthy", async () => {
  const { deps, stdoutLines } = fakeDeps();
  const pages = new Map<string, string>([["https://x.com/home", "home ".repeat(60)]]);
  for (const topic of STANDING_X_TOPICS) {
    pages.set(xSearchUrl(topic.query, { live: true }), "post text ".repeat(40));
  }
  const client = new FakeBrowserClient("x", pages);

  const exitCode = await runXCommand(["search-sweep"], deps, client, { sleep: noopSleep });

  assert.equal(exitCode, 0);
  const output = stdoutLines.join("\n");
  for (const topic of STANDING_X_TOPICS) {
    assert.match(output, new RegExp(`## ${topic.name.replace(/[/]/g, "\\/")} \\[ok\\]`));
  }
});

test("orchestrator x search-sweep exits 1 and reports SESSION UNHEALTHY when the health check fails", async () => {
  const { deps, stdoutLines } = fakeDeps();
  const client = new FakeBrowserClient("x", new Map()); // no fixture for the health-check URL => throws

  const exitCode = await runXCommand(["search-sweep"], deps, client, { sleep: noopSleep });

  assert.equal(exitCode, 1);
  assert.match(stdoutLines.join("\n"), /SESSION UNHEALTHY/);
});

test("orchestrator x with an unknown subcommand prints usage and exits 1", async () => {
  const { deps, stderrLines } = fakeDeps();
  const exitCode = await runXCommand([], deps, new FakeBrowserClient("x"), { sleep: noopSleep });
  assert.equal(exitCode, 1);
  assert.match(stderrLines.join("\n"), /Usage: orchestrator x search-sweep/);
});
