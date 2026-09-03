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

function buildDeps(): { stderr: string[]; deps: CliDeps } {
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
    stdout: () => {},
    stderr: (line: string) => stderr.push(line),
  };
  return { stderr, deps };
}

test("dashboard rejects a non-numeric --port without starting a server", async () => {
  const { stderr, deps } = buildDeps();
  const code = await runCli(["dashboard", "--port", "not-a-number"], deps);
  assert.equal(code, 1);
  assert.match(stderr.join("\n"), /--port must be a positive integer/);
});

test("dashboard rejects a zero or negative --port without starting a server", async () => {
  const { stderr, deps } = buildDeps();
  const code = await runCli(["dashboard", "--port", "0"], deps);
  assert.equal(code, 1);
  assert.match(stderr.join("\n"), /--port must be a positive integer/);
});
