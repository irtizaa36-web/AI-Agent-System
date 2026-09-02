import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, parseTestSummary, getGitStatus, getTestStatus } from "./index";
import { loadDefaultConfig } from "../config/load";
import { InMemoryRunStore } from "../store/run-store";
import { InMemoryWorkflowStore } from "../store/workflow-store";
import { FakeInkboxClient } from "../integrations/inkbox/fake-client";
import { InMemoryForwardingLog } from "../integrations/inkbox/forwarding-log";
import { InMemoryMessageEventLog } from "../integrations/inkbox/message-event-log";
import type { CliDeps } from "./index";

function captureOutput(): { stdout: string[]; stderr: string[]; deps: Omit<CliDeps, "registry" | "store"> } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      cwd: process.cwd(),
      inkboxClient: new FakeInkboxClient(),
      forwardingLog: new InMemoryForwardingLog(),
      messageEventLog: new InMemoryMessageEventLog(),
      workflowStore: new InMemoryWorkflowStore(),
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  };
}

test("runCli with no command prints usage and exits 0", async () => {
  const { stdout, deps } = captureOutput();
  const code = await runCli([], { ...deps, registry: loadDefaultConfig(), store: new InMemoryRunStore() });

  assert.equal(code, 0);
  assert.match(stdout.join("\n"), /Usage:/);
});

test("runCli rejects an unknown command", async () => {
  const { stdout: _stdout, stderr, deps } = captureOutput();
  const code = await runCli(["bogus"], { ...deps, registry: loadDefaultConfig(), store: new InMemoryRunStore() });

  assert.equal(code, 1);
  assert.match(stderr.join("\n"), /Unknown command "bogus"/);
});

test("runCli list-agents lists the built-in agents", async () => {
  const { stdout, deps } = captureOutput();
  const code = await runCli(["list-agents"], { ...deps, registry: loadDefaultConfig(), store: new InMemoryRunStore() });

  assert.equal(code, 0);
  const output = stdout.join("\n");
  assert.match(output, /^default\t/m);
  assert.match(output, /^demo\t/m);
});

test("runCli run requires --task", async () => {
  const { stderr, deps } = captureOutput();
  const code = await runCli(["run", "--agent", "demo"], { ...deps, registry: loadDefaultConfig(), store: new InMemoryRunStore() });

  assert.equal(code, 1);
  assert.match(stderr.join("\n"), /Usage: orchestrator run/);
});

test("runCli run reports a helpful error for an unknown agent", async () => {
  const { stderr, deps } = captureOutput();
  const code = await runCli(["run", "--task", "hi", "--agent", "nope"], {
    ...deps,
    registry: loadDefaultConfig(),
    store: new InMemoryRunStore(),
  });

  assert.equal(code, 1);
  assert.match(stderr.join("\n"), /Unknown agent "nope"\. Available: default, demo/);
});

test("runCli run --agent demo runs end-to-end with the fake provider, no API key needed", async () => {
  const { stdout, deps } = captureOutput();
  const store = new InMemoryRunStore();
  const code = await runCli(["run", "--task", "say hello", "--agent", "demo"], {
    ...deps,
    registry: loadDefaultConfig(),
    store,
  });

  assert.equal(code, 0);
  const output = stdout.join("\n");
  assert.match(output, /Echo: say hello/);
  assert.equal((await store.list()).length, 1);
});

test("runCli run --agent default fails clearly when no API key is configured", async () => {
  const originalKey = process.env["ANTHROPIC_API_KEY"];
  delete process.env["ANTHROPIC_API_KEY"];

  try {
    const { stderr, deps } = captureOutput();
    const code = await runCli(["run", "--task", "say hello"], {
      ...deps,
      registry: loadDefaultConfig(),
      store: new InMemoryRunStore(),
    });

    assert.equal(code, 1);
    assert.match(stderr.join("\n"), /ANTHROPIC_API_KEY is not set/);
  } finally {
    if (originalKey !== undefined) process.env["ANTHROPIC_API_KEY"] = originalKey;
  }
});

test("runCli status reports agent/provider/tool/pack counts and names", async () => {
  const { stdout, deps } = captureOutput();
  const code = await runCli(["status"], { ...deps, registry: loadDefaultConfig(), store: new InMemoryRunStore() });

  assert.equal(code, 0);
  const output = stdout.join("\n");
  assert.match(output, /Agents:\s+7 \(default, demo, inkbox-send, personal-admin, dispatcher, career-advisor, case-report-writer\)/);
  assert.match(output, /Providers:\s+2 \(claude, fake\)/);
  assert.match(output, /Tools:\s+6 \(read-file, inkbox-search-mail, inkbox-read-thread, inkbox-save-draft, send-email, read-web-page\)/);
  assert.match(output, /Packs:\s+5 \(core-demo, personal-assistant, dispatcher, career-advisor, ai-research\)/);
  assert.match(output, /Tests:\s+\S/);
  assert.match(output, /Git:\s+\S/);
  assert.match(output, /Capabilities currently available:/);
  assert.match(output, /Run "demo" \(provider: fake, tools: none\)/);
});

test("parseTestSummary extracts pass/fail counts from node's test runner summary", () => {
  const output = "some lines\nℹ tests 33\nℹ suites 0\nℹ pass 33\nℹ fail 0\nℹ cancelled 0\n";
  assert.equal(parseTestSummary(output), "33/33 passing");
});

test("parseTestSummary reports failures when present", () => {
  assert.equal(parseTestSummary("ℹ tests 5\nℹ pass 3\nℹ fail 2\n"), "3/5 passing, 2 failing");
});

test("parseTestSummary returns undefined for output it doesn't recognize", () => {
  assert.equal(parseTestSummary("garbage"), undefined);
});

test("getGitStatus reports clean, then reports uncommitted changes, for a real temp repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchestrator-cli-git-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    assert.equal(getGitStatus(dir), "clean");

    await writeFile(join(dir, "new-file.txt"), "hello", "utf-8");
    assert.match(getGitStatus(dir), /1 file\(s\) with uncommitted changes/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getGitStatus reports unknown for a directory that isn't a Git repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchestrator-cli-nogit-"));
  try {
    assert.match(getGitStatus(dir), /unknown/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getTestStatus reports not-built when the target directory has no dist/", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchestrator-cli-nodist-"));
  try {
    assert.match(getTestStatus(dir), /not built yet/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getTestStatus refuses to recurse when already inside a status check", () => {
  const guardVar = "ORCHESTRATOR_STATUS_CHECK_IN_PROGRESS";
  const original = process.env[guardVar];
  process.env[guardVar] = "1";

  try {
    assert.match(getTestStatus(process.cwd()), /skipped \(already inside a status check\)/);
  } finally {
    if (original === undefined) delete process.env[guardVar];
    else process.env[guardVar] = original;
  }
});
