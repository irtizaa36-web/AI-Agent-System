import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "./index";
import type { CliDeps } from "./index";
import { loadDefaultConfig } from "../config/load";
import { InMemoryRunStore } from "../store/run-store";
import { InMemoryWorkflowStore } from "../store/workflow-store";
import { FakeInkboxClient } from "../integrations/inkbox/fake-client";
import { InMemoryForwardingLog } from "../integrations/inkbox/forwarding-log";
import { InMemoryMessageEventLog } from "../integrations/inkbox/message-event-log";
import { InMemoryCoworkerTaskStore } from "../coworker/store";
import { InMemoryAgentStatusStore } from "../dashboard/agent-status-store";
import { InMemoryRecommendationStore } from "../dashboard/recommendation-store";

function buildDeps(): { stdout: string[]; stderr: string[]; deps: CliDeps } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: CliDeps = {
    registry: loadDefaultConfig(),
    store: new InMemoryRunStore(),
    workflowStore: new InMemoryWorkflowStore(),
    cwd: process.cwd(),
    inkboxClient: new FakeInkboxClient(),
    forwardingLog: new InMemoryForwardingLog(),
    messageEventLog: new InMemoryMessageEventLog(),
    coworkerStore: new InMemoryCoworkerTaskStore(),
    agentStatusStore: new InMemoryAgentStatusStore(),
    recommendationStore: new InMemoryRecommendationStore(),
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
  };
  return { stdout, stderr, deps };
}

test("recommend add requires both a summary and a scope", async () => {
  const { stderr, deps } = buildDeps();
  const code = await runCli(["recommend", "add", "do something"], deps);
  assert.equal(code, 1);
  assert.match(stderr.join("\n"), /Usage/);
});

test("recommend add then list shows it as pending", async () => {
  const { stdout, deps } = buildDeps();
  await runCli(["recommend", "add", "add dark mode", "--scope", "dashboard"], deps);

  const before = stdout.length;
  await runCli(["recommend", "list"], deps);
  const text = stdout.slice(before).join("\n");
  assert.match(text, /\[pending\]/);
  assert.match(text, /add dark mode/);
});

test("recommend implemented marks it done with details", async () => {
  const { stdout, deps } = buildDeps();
  await runCli(["recommend", "add", "fix the recipe", "--scope", "system"], deps);
  const id = stdout[0].match(/Logged recommendation (\S+)/)?.[1];
  assert.ok(id);

  const code = await runCli(["recommend", "implemented", id!, "--details", "switched to node dist/cli/index.js"], deps);
  assert.equal(code, 0);

  const before = stdout.length;
  await runCli(["recommend", "list"], deps);
  const text = stdout.slice(before).join("\n");
  assert.match(text, /\[implemented\]/);
  assert.match(text, /switched to node dist\/cli\/index\.js/);
});

test("recommend implemented on an unknown id fails clearly", async () => {
  const { stderr, deps } = buildDeps();
  const code = await runCli(["recommend", "implemented", "no-such-id"], deps);
  assert.equal(code, 1);
  assert.match(stderr.join("\n"), /No recommendation/);
});
