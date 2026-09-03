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

test("coworker add requires task text and a valid --to", async () => {
  const { stderr, deps } = buildDeps();
  assert.equal(await runCli(["coworker", "add"], deps), 1);
  assert.match(stderr[0], /Usage/);

  const { stderr: stderr2, deps: deps2 } = buildDeps();
  assert.equal(await runCli(["coworker", "add", "do a thing", "--to", "someone-else"], deps2), 1);
  assert.match(stderr2[0], /--to must be one of/);
});

test("coworker add then list shows a pending task for the assigned persona", async () => {
  const { stdout, deps } = buildDeps();
  assert.equal(await runCli(["coworker", "add", "look into X", "--to", "macmini"], deps), 0);
  assert.match(stdout[0], /Added coworker task/);

  assert.equal(await runCli(["coworker", "list"], deps), 0);
  const listed = stdout.slice(1).join("\n");
  assert.match(listed, /\[pending\]/);
  assert.match(listed, /look into X/);
});

test("coworker list --for only shows tasks assigned to that persona or 'both'", async () => {
  const { stdout, deps } = buildDeps();
  await runCli(["coworker", "add", "for macmini only", "--to", "macmini"], deps);
  await runCli(["coworker", "add", "for laptop only", "--to", "Laptop2"], deps);
  await runCli(["coworker", "add", "for both", "--to", "both"], deps);

  const before = stdout.length;
  await runCli(["coworker", "list", "--for", "macmini"], deps);
  const text = stdout.slice(before).join("\n");
  assert.match(text, /for macmini only/);
  assert.match(text, /for both/);
  assert.doesNotMatch(text, /for laptop only/);
});

test("coworker dispatched then complete moves a single-persona task from pending to in_progress to done", async () => {
  const { stdout, deps } = buildDeps();
  await runCli(["coworker", "add", "do a thing", "--to", "macmini"], deps);
  const id = stdout[0].match(/task (\S+) for/)?.[1];
  assert.ok(id);

  assert.equal(await runCli(["coworker", "dispatched", id!, "--persona", "macmini"], deps), 0);
  let before = stdout.length;
  await runCli(["coworker", "list"], deps);
  assert.match(stdout.slice(before).join("\n"), /\[in_progress\]/);

  assert.equal(await runCli(["coworker", "complete", id!, "--persona", "macmini", "--output", "all done"], deps), 0);
  before = stdout.length;
  await runCli(["coworker", "list"], deps);
  const text = stdout.slice(before).join("\n");
  assert.match(text, /\[done\]/);
  assert.match(text, /succeeded/);
  assert.match(text, /all done/);
});

test("coworker complete on a persona the task isn't assigned to fails clearly", async () => {
  const { stdout, stderr, deps } = buildDeps();
  await runCli(["coworker", "add", "do a thing", "--to", "macmini"], deps);
  const id = stdout[0].match(/task (\S+) for/)?.[1];

  const code = await runCli(["coworker", "complete", id!, "--persona", "Laptop2", "--output", "x"], deps);
  assert.equal(code, 1);
  assert.match(stderr.join("\n"), /not assigned/);
});

test("coworker complete on an unknown task id fails clearly", async () => {
  const { stderr, deps } = buildDeps();
  const code = await runCli(["coworker", "complete", "no-such-id", "--persona", "macmini", "--output", "x"], deps);
  assert.equal(code, 1);
  assert.match(stderr.join("\n"), /No coworker task/);
});

test("coworker with no subcommand prints usage", async () => {
  const { stderr, deps } = buildDeps();
  assert.equal(await runCli(["coworker"], deps), 1);
  assert.match(stderr.join("\n"), /Usage: orchestrator coworker add/);
});
