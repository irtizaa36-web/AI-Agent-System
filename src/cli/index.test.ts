import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "./index";
import { loadDefaultConfig } from "../config/load";
import { InMemoryRunStore } from "../store/run-store";
import type { CliDeps } from "./index";

function captureOutput(): { stdout: string[]; stderr: string[]; deps: Omit<CliDeps, "registry" | "store"> } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
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
