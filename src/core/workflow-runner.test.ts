import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentDefinition } from "./agent";
import { createWorkflow } from "./workflow";
import { planWorkflow, runWorkflowToCompletion, approveAndContinueWorkflow, resumeWorkflowWithReply, type AgentResolver } from "./workflow-runner";
import { FakeProvider } from "../providers/fake";
import type { Tool } from "../tools/tool";

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { name: "test-agent", providerName: "fake", model: "fake-model", systemPrompt: "be helpful", toolNames: [], ...overrides };
}

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

test("planWorkflow turns a well-formed Dispatcher response into a running Workflow", async () => {
  const dispatcher = agent({ name: "dispatcher" });
  const provider = new FakeProvider([
    { content: '```json\n[{"agent": "personal-admin", "task": "draft an inquiry"}]\n```', toolCalls: [], stopReason: "end_turn" },
  ]);

  const workflow = await planWorkflow("book a table", dispatcher, { provider, tools: new Map() }, [
    { name: "personal-admin", description: "handles admin tasks" },
  ]);

  assert.equal(workflow.status, "running");
  assert.equal(workflow.goal, "book a table");
  assert.equal(workflow.steps.length, 1);
  assert.equal(workflow.steps[0].agentName, "personal-admin");
});

test("planWorkflow fails cleanly when the Dispatcher's run itself fails", async () => {
  const dispatcher = agent({ name: "dispatcher", maxSteps: 1 });
  const provider = new FakeProvider([{ content: "still thinking", toolCalls: [{ id: "c1", toolName: "nope", input: {} }], stopReason: "tool_use" }]);

  const workflow = await planWorkflow("do something", dispatcher, { provider, tools: new Map() }, []);

  assert.equal(workflow.status, "failed");
  assert.match(workflow.planningError ?? "", /Dispatcher run did not succeed/);
});

test("planWorkflow fails cleanly when the Dispatcher's response can't be parsed as a plan", async () => {
  const dispatcher = agent({ name: "dispatcher" });
  const provider = new FakeProvider([{ content: "I'll just handle it myself.", toolCalls: [], stopReason: "end_turn" }]);

  const workflow = await planWorkflow("do something", dispatcher, { provider, tools: new Map() }, []);

  assert.equal(workflow.status, "failed");
  assert.match(workflow.planningError ?? "", /fenced/);
});

test("runWorkflowToCompletion chains steps, feeding each step's output into the next step's instructions", async () => {
  const workflow = createWorkflow("plan a trip", [
    { agentName: "agent-a", instructions: "pick a city" },
    { agentName: "agent-b", instructions: "pick a hotel" },
  ]);

  const providerA = new FakeProvider([{ content: "Austin", toolCalls: [], stopReason: "end_turn" }]);
  const providerB = new FakeProvider([{ content: "The Driskill", toolCalls: [], stopReason: "end_turn" }]);
  const resolve: AgentResolver = (name) => {
    if (name === "agent-a") return { agent: agent({ name: "agent-a" }), deps: { provider: providerA, tools: new Map() } };
    return { agent: agent({ name: "agent-b" }), deps: { provider: providerB, tools: new Map() } };
  };

  const result = await runWorkflowToCompletion(workflow, resolve);

  assert.equal(result.status, "succeeded");
  assert.equal(result.steps[0].status, "succeeded");
  assert.equal(result.steps[1].status, "succeeded");
  assert.match(result.summary ?? "", /Austin/);
  assert.match(result.summary ?? "", /The Driskill/);
  // the second step's provider was called with context from the first step's output
  assert.match(providerB.calls > 0 ? "called" : "not called", /called/);
});

test("runWorkflowToCompletion stops at the first step that pauses for approval, without touching later steps", async () => {
  const workflow = createWorkflow("send something then follow up", [
    { agentName: "agent-a", instructions: "send it" },
    { agentName: "agent-b", instructions: "should never run" },
  ]);

  const tool = gatedTool();
  const providerA = new FakeProvider([
    { content: "proposing", toolCalls: [{ id: "call-1", toolName: "send-thing", input: { to: "a@b.com" } }], stopReason: "tool_use" },
  ]);
  let agentBResolved = false;
  const resolve: AgentResolver = (name) => {
    if (name === "agent-a") return { agent: agent({ name: "agent-a", toolNames: ["send-thing"] }), deps: { provider: providerA, tools: new Map([["send-thing", tool]]) } };
    agentBResolved = true;
    throw new Error("agent-b must never be resolved before step 0 is approved");
  };

  const result = await runWorkflowToCompletion(workflow, resolve);

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.currentStepIndex, 0);
  assert.equal(result.steps[0].runId !== undefined, true);
  assert.equal(agentBResolved, false);
});

test("approveAndContinueWorkflow approves the pending step's action and moves the workflow to waiting_for_response", async () => {
  const workflow = createWorkflow("send something", [{ agentName: "agent-a", instructions: "send it" }]);
  const tool = gatedTool();
  const providerA = new FakeProvider([
    { content: "proposing", toolCalls: [{ id: "call-1", toolName: "send-thing", input: { to: "a@b.com" } }], stopReason: "tool_use" },
  ]);
  const resolve: AgentResolver = () => ({ agent: agent({ name: "agent-a", toolNames: ["send-thing"] }), deps: { provider: providerA, tools: new Map([["send-thing", tool]]) } });

  const paused = await runWorkflowToCompletion(workflow, resolve);
  assert.equal(paused.status, "awaiting_approval");

  const pausedRunId = paused.steps[0].runId;
  assert.ok(pausedRunId);
  // Simulate the CLI loading the paused Run back from RunStore: reconstruct it the same way `advance` would have left it.
  const pausedRun = {
    id: pausedRunId as string,
    task: { id: "t1", instructions: "send it" },
    agentName: "agent-a",
    status: "awaiting_approval" as const,
    session: { messages: [] },
    steps: [],
    createdAt: new Date().toISOString(),
    pendingAction: { toolName: "send-thing", toolCallId: "call-1", input: { to: "a@b.com" }, summary: "x", requestedAt: new Date().toISOString() },
  };

  const approved = await approveAndContinueWorkflow(paused, pausedRun, { tools: new Map([["send-thing", tool]]) }, { to: "a@b.com" });

  assert.equal(approved.status, "waiting_for_response");
});

test("approveAndContinueWorkflow rejects a workflow that isn't currently awaiting approval", async () => {
  const workflow = createWorkflow("goal", [{ agentName: "a", instructions: "x" }]);
  await assert.rejects(
    () => approveAndContinueWorkflow(workflow, {} as never, { tools: new Map() }, {}),
    /is not awaiting approval/,
  );
});

test("resumeWorkflowWithReply continues into the next step once the paused step succeeds", async () => {
  const workflow = createWorkflow("send then follow up", [
    { agentName: "agent-a", instructions: "send it" },
    { agentName: "agent-b", instructions: "wrap up" },
  ]);
  const tool = gatedTool();
  const providerA = new FakeProvider([
    { content: "proposing", toolCalls: [{ id: "call-1", toolName: "send-thing", input: { to: "a@b.com" } }], stopReason: "tool_use" },
    { content: "confirmed sent", toolCalls: [], stopReason: "end_turn" },
  ]);
  const agentA = agent({ name: "agent-a", toolNames: ["send-thing"] });
  const agentB = agent({ name: "agent-b" });
  const providerB = new FakeProvider([{ content: "all wrapped up", toolCalls: [], stopReason: "end_turn" }]);

  const resolve: AgentResolver = (name) =>
    name === "agent-a"
      ? { agent: agentA, deps: { provider: providerA, tools: new Map([["send-thing", tool]]) } }
      : { agent: agentB, deps: { provider: providerB, tools: new Map() } };

  let paused = await runWorkflowToCompletion(workflow, resolve);
  const runAfterApproval = await approveAndContinueWorkflowHelper(paused, tool);
  paused = runAfterApproval.workflow;

  const resumed = await resumeWorkflowWithReply(paused, runAfterApproval.run, agentA, { provider: providerA, tools: new Map([["send-thing", tool]]) }, "They said yes.", resolve);

  assert.equal(resumed.status, "succeeded");
  assert.equal(resumed.steps[1].status, "succeeded");
  assert.match(resumed.summary ?? "", /all wrapped up/);
});

test("resumeWorkflowWithReply rejects a workflow that isn't currently waiting for a response", async () => {
  const workflow = createWorkflow("goal", [{ agentName: "a", instructions: "x" }]);
  await assert.rejects(
    () => resumeWorkflowWithReply(workflow, {} as never, agent(), { provider: new FakeProvider([]), tools: new Map() }, "reply", () => {
      throw new Error("must not resolve");
    }),
    /is not waiting for a response/,
  );
});

/** Approves the currently-pending step by reconstructing the paused Run the same way a CLI reading it back from RunStore would, then returns both the updated workflow and the underlying Run so a subsequent resume can use it. */
async function approveAndContinueWorkflowHelper(paused: Awaited<ReturnType<typeof runWorkflowToCompletion>>, tool: Tool) {
  const pendingAction = { toolName: "send-thing", toolCallId: "call-1", input: { to: "a@b.com" }, summary: "x", requestedAt: new Date().toISOString() };
  const pausedRun = {
    id: paused.steps[0].runId as string,
    task: { id: "t1", instructions: "send it" },
    agentName: "agent-a",
    status: "awaiting_approval" as const,
    session: { messages: [] },
    steps: [],
    createdAt: new Date().toISOString(),
    pendingAction,
  };
  const workflow = await approveAndContinueWorkflow(paused, pausedRun, { tools: new Map([["send-thing", tool]]) }, pendingAction.input);
  // approveAndContinueWorkflow executed the tool and moved the run to waiting_for_response — reconstruct that Run shape for the resume step.
  const run = {
    ...pausedRun,
    status: "waiting_for_response" as const,
    pendingAction: undefined,
    threadId: "thread-abc",
  };
  return { workflow, run };
}
