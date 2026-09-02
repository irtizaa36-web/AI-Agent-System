import { test } from "node:test";
import assert from "node:assert/strict";
import { createTask } from "./task";
import type { AgentDefinition } from "./agent";
import { startRun, advance, runToCompletion } from "./orchestrator";
import { FakeProvider } from "../providers/fake";
import type { Tool } from "../tools/tool";

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "test-agent",
    providerName: "fake",
    model: "fake-model",
    systemPrompt: "be helpful",
    toolNames: [],
    ...overrides,
  };
}

test("startRun seeds a queued Run from the Agent's system prompt and the Task", () => {
  const task = createTask("say hi");
  const run = startRun(task, agent(), "run-1");

  assert.equal(run.id, "run-1");
  assert.equal(run.status, "queued");
  assert.equal(run.steps.length, 0);
  assert.equal(run.session.messages[1]?.content, "say hi");
});

test("advance succeeds a Run in one step when the Provider ends the turn immediately", async () => {
  const task = createTask("say hi");
  const run = startRun(task, agent());
  const provider = new FakeProvider([{ content: "hello!", toolCalls: [], stopReason: "end_turn" }]);

  const next = await advance(run, agent(), { provider, tools: new Map() });

  assert.equal(next.status, "succeeded");
  assert.equal(next.result?.output, "hello!");
  assert.equal(next.steps.length, 1);
});

test("advance executes a requested Tool and keeps the Run running", async () => {
  const echoTool: Tool = {
    name: "echo",
    description: "echoes its input",
    inputSchema: {},
    execute: (input) => `echoed:${String(input)}`,
  };
  const task = createTask("use the tool");
  const testAgent = agent({ toolNames: ["echo"] });
  const run = startRun(task, testAgent);
  const provider = new FakeProvider([
    {
      content: "calling echo",
      toolCalls: [{ id: "call-1", toolName: "echo", input: "ping" }],
      stopReason: "tool_use",
    },
  ]);

  const next = await advance(run, testAgent, {
    provider,
    tools: new Map([["echo", echoTool]]),
  });

  assert.equal(next.status, "running");
  const toolMessage = next.session.messages.at(-1);
  assert.equal(toolMessage?.role, "tool");
  assert.equal(toolMessage?.content, "echoed:ping");
});

test("advance fails a Run that requests a Tool the Agent isn't wired with", async () => {
  const task = createTask("use a missing tool");
  const testAgent = agent({ toolNames: ["missing"] });
  const run = startRun(task, testAgent);
  const provider = new FakeProvider([]);

  await assert.rejects(
    () => advance(run, testAgent, { provider, tools: new Map() }),
    /Unknown tool "missing"/,
  );
});

test("advance fails a Run once it exceeds its max steps, without calling the Provider again", async () => {
  const task = createTask("loop forever");
  const testAgent = agent({ maxSteps: 1 });
  const run = startRun(task, testAgent);
  const runAtLimit = { ...run, steps: [{ index: 0, responseContent: "x", toolCalls: [] }] };
  const provider = new FakeProvider([]);

  const next = await advance(runAtLimit, testAgent, { provider, tools: new Map() });

  assert.equal(next.status, "failed");
  assert.match(next.result?.error ?? "", /Exceeded max steps/);
  assert.equal(provider.calls, 0);
});

test("runToCompletion drives a multi-step tool-use Run through to success", async () => {
  const echoTool: Tool = {
    name: "echo",
    description: "echoes its input",
    inputSchema: {},
    execute: (input) => `echoed:${String(input)}`,
  };
  const task = createTask("use the tool then finish");
  const testAgent = agent({ toolNames: ["echo"] });
  const provider = new FakeProvider([
    {
      content: "calling echo",
      toolCalls: [{ id: "call-1", toolName: "echo", input: "ping" }],
      stopReason: "tool_use",
    },
    { content: "all done", toolCalls: [], stopReason: "end_turn" },
  ]);

  const run = await runToCompletion(task, testAgent, {
    provider,
    tools: new Map([["echo", echoTool]]),
  });

  assert.equal(run.status, "succeeded");
  assert.equal(run.result?.output, "all done");
  assert.equal(run.steps.length, 2);
  assert.equal(provider.calls, 2);
});
