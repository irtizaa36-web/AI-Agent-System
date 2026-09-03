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

test("agent-status set rejects an invalid status", async () => {
  const { stderr, deps } = buildDeps();
  const code = await runCli(["agent-status", "set", "macmini", "--status", "napping"], deps);
  assert.equal(code, 1);
  assert.match(stderr.join("\n"), /--status must be one of/);
});

test("agent-status set then list reflects the latest report", async () => {
  const { stdout, deps } = buildDeps();
  await runCli(["agent-status", "set", "macmini", "--status", "working", "--task", "task-1"], deps);

  const before = stdout.length;
  await runCli(["agent-status", "list"], deps);
  const text = stdout.slice(before).join("\n");
  assert.match(text, /macmini: working \(task-1\)/);
});

test("agent-status list reports when nothing has reported yet", async () => {
  const { stdout, deps } = buildDeps();
  await runCli(["agent-status", "list"], deps);
  assert.match(stdout.join("\n"), /No agent has reported/);
});
