import { test } from "node:test";
import assert from "node:assert/strict";
import { createTask } from "./task";
import type { AgentDefinition } from "./agent";
import { startRun, advance, runToCompletion, approveAndExecute, resumeWithReply } from "./orchestrator";
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
  assert.equal(Number.isNaN(Date.parse(run.createdAt)), false);
  assert.equal(run.completedAt, undefined);
});

test("advance succeeds a Run in one step when the Provider ends the turn immediately", async () => {
  const task = createTask("say hi");
  const run = startRun(task, agent());
  const provider = new FakeProvider([{ content: "hello!", toolCalls: [], stopReason: "end_turn" }]);

  const next = await advance(run, agent(), { provider, tools: new Map() });

  assert.equal(next.status, "succeeded");
  assert.equal(next.result?.output, "hello!");
  assert.equal(next.steps.length, 1);
  assert.equal(Number.isNaN(Date.parse(next.steps[0]?.occurredAt ?? "")), false);
  assert.equal(Number.isNaN(Date.parse(next.completedAt ?? "")), false);
});

test("advance fails a Run whose response was truncated (max_tokens), rather than treating a cut-off draft as succeeded", async () => {
  const task = createTask("write something long");
  const run = startRun(task, agent());
  const provider = new FakeProvider([{ content: "this got cut off mid-sen", toolCalls: [], stopReason: "max_tokens" }]);

  const next = await advance(run, agent(), { provider, tools: new Map() });

  assert.equal(next.status, "failed");
  assert.match(next.result?.error ?? "", /truncated/);
  assert.match(next.result?.error ?? "", /max_tokens/);
  assert.equal(next.result?.output, "");
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

test("advance feeds a Tool's execution error back as a tool result, rather than crashing the Run", async () => {
  const task = createTask("call a tool with bad input");
  const testAgent = agent({ toolNames: ["picky"] });
  const run = startRun(task, testAgent);
  const pickyTool: Tool = {
    name: "picky",
    description: "rejects malformed input",
    inputSchema: {},
    execute: () => {
      throw new Error('picky requires { "address": string }');
    },
  };
  const provider = new FakeProvider([
    { content: "calling it", toolCalls: [{ id: "call-1", toolName: "picky", input: { wrong: "shape" } }], stopReason: "tool_use" },
  ]);

  const next = await advance(run, testAgent, { provider, tools: new Map([["picky", pickyTool]]) });

  assert.equal(next.status, "running");
  const toolMessage = next.session.messages.at(-1);
  assert.equal(toolMessage?.role, "tool");
  assert.match(toolMessage?.content ?? "", /^Error: picky requires/);
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
  const runAtLimit = {
    ...run,
    steps: [{ index: 0, occurredAt: new Date().toISOString(), responseContent: "x", toolCalls: [] }],
  };
  const provider = new FakeProvider([]);

  const next = await advance(runAtLimit, testAgent, { provider, tools: new Map() });

  assert.equal(next.status, "failed");
  assert.match(next.result?.error ?? "", /Exceeded max steps/);
  assert.equal(provider.calls, 0);
  assert.equal(Number.isNaN(Date.parse(next.completedAt ?? "")), false);
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
  assert.ok(run.steps.every((step) => !Number.isNaN(Date.parse(step.occurredAt))));
  assert.equal(Number.isNaN(Date.parse(run.completedAt ?? "")), false);
});

function gatedTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "send-thing",
    description: "a consequential tool",
    inputSchema: {},
    requiresApproval: true,
    execute: (input) => `sent:${JSON.stringify(input)}\nthreadId:thread-abc`,
    ...overrides,
  };
}

test("advance pauses a Run awaiting approval when a requiresApproval Tool is called, without executing it", async () => {
  const testAgent = agent({ toolNames: ["send-thing"] });
  const run = startRun(createTask("send it"), testAgent);
  const tool = gatedTool({ execute: () => { throw new Error("must never execute before approval"); } });
  const provider = new FakeProvider([
    { content: "proposing to send", toolCalls: [{ id: "call-1", toolName: "send-thing", input: { to: "a@b.com" } }], stopReason: "tool_use" },
  ]);

  const next = await advance(run, testAgent, { provider, tools: new Map([["send-thing", tool]]) });

  assert.equal(next.status, "awaiting_approval");
  assert.equal(next.pendingAction?.toolName, "send-thing");
  assert.deepEqual(next.pendingAction?.input, { to: "a@b.com" });
  assert.equal(next.pendingAction?.toolCallId, "call-1");
  // no tool-result message was appended, since nothing executed
  assert.equal(next.session.messages.at(-1)?.role, "assistant");
});

test("approveAndExecute rejects when the approval input doesn't exactly match the pending action", async () => {
  const testAgent = agent({ toolNames: ["send-thing"] });
  const run = startRun(createTask("send it"), testAgent);
  const tool = gatedTool();
  const provider = new FakeProvider([
    { content: "proposing", toolCalls: [{ id: "call-1", toolName: "send-thing", input: { to: "a@b.com" } }], stopReason: "tool_use" },
  ]);
  const deps = { provider, tools: new Map([["send-thing", tool]]) };
  const awaitingApproval = await advance(run, testAgent, deps);

  await assert.rejects(
    () => approveAndExecute(awaitingApproval, deps, { to: "different@b.com" }),
    /Approval does not match the pending action/,
  );
});

test("approveAndExecute rejects a Run that isn't currently awaiting approval", async () => {
  const testAgent = agent();
  const run = startRun(createTask("hi"), testAgent);
  await assert.rejects(
    () => approveAndExecute(run, { tools: new Map() }, {}),
    /is not awaiting approval/,
  );
});

test("approveAndExecute executes the exact-matching pending action and moves the Run to waiting_for_response", async () => {
  const testAgent = agent({ toolNames: ["send-thing"] });
  const run = startRun(createTask("send it"), testAgent);
  const tool = gatedTool();
  const provider = new FakeProvider([
    { content: "proposing", toolCalls: [{ id: "call-1", toolName: "send-thing", input: { to: "a@b.com" } }], stopReason: "tool_use" },
  ]);
  const deps = { provider, tools: new Map([["send-thing", tool]]) };
  const awaitingApproval = await advance(run, testAgent, deps);

  const approved = await approveAndExecute(awaitingApproval, deps, { to: "a@b.com" });

  assert.equal(approved.status, "waiting_for_response");
  assert.equal(approved.pendingAction, undefined);
  assert.equal(approved.threadId, "thread-abc");
  const toolMessage = approved.session.messages.at(-1);
  assert.equal(toolMessage?.role, "tool");
  assert.equal(toolMessage?.toolCallId, "call-1");
});

test("resumeWithReply rejects a Run that isn't currently waiting for a response", async () => {
  const testAgent = agent();
  const run = startRun(createTask("hi"), testAgent);
  await assert.rejects(
    () => resumeWithReply(run, testAgent, { provider: new FakeProvider([]), tools: new Map() }, "reply"),
    /is not waiting for a response/,
  );
});

test("resumeWithReply appends the reply and drives the Run onward to completion", async () => {
  const testAgent = agent({ toolNames: ["send-thing"] });
  const run = startRun(createTask("send it"), testAgent);
  const tool = gatedTool();
  const proposeProvider = new FakeProvider([
    { content: "proposing", toolCalls: [{ id: "call-1", toolName: "send-thing", input: { to: "a@b.com" } }], stopReason: "tool_use" },
  ]);
  const proposeDeps = { provider: proposeProvider, tools: new Map([["send-thing", tool]]) };
  const awaitingApproval = await advance(run, testAgent, proposeDeps);
  const waiting = await approveAndExecute(awaitingApproval, proposeDeps, { to: "a@b.com" });

  const resumeProvider = new FakeProvider([{ content: "great, all set", toolCalls: [], stopReason: "end_turn" }]);
  const resumed = await resumeWithReply(
    waiting,
    testAgent,
    { provider: resumeProvider, tools: new Map([["send-thing", tool]]) },
    "They offered 7pm.",
  );

  assert.equal(resumed.status, "succeeded");
  assert.equal(resumed.result?.output, "great, all set");
  const replyMessage = resumed.session.messages.find((m) => m.content.includes("They offered 7pm."));
  assert.equal(replyMessage?.role, "user");
});
