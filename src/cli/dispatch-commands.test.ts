import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "./index";
import type { CliDeps } from "./index";
import { Registry } from "../registry/registry";
import { InMemoryRunStore } from "../store/run-store";
import { InMemoryWorkflowStore } from "../store/workflow-store";
import { FakeInkboxClient } from "../integrations/inkbox/fake-client";
import { InMemoryForwardingLog } from "../integrations/inkbox/forwarding-log";
import { InMemoryMessageEventLog } from "../integrations/inkbox/message-event-log";
import { InMemoryCoworkerTaskStore } from "../coworker/store";
import { dispatcherPack } from "../packs/dispatcher/pack";
import type { GenerateResult, ModelProvider } from "../providers/provider";
import type { Tool } from "../tools/tool";

/** A ModelProvider under a caller-chosen name (FakeProvider's own `name` is hardcoded to "fake"), so an agent's real `providerName: "claude"` can be tested without a live API key. */
class ScriptedProvider implements ModelProvider {
  private readonly script: GenerateResult[];
  constructor(readonly name: string, script: readonly GenerateResult[]) {
    this.script = [...script];
  }
  async generate(): Promise<GenerateResult> {
    const next = this.script.shift();
    if (!next) throw new Error(`ScriptedProvider "${this.name}" ran out of script`);
    return next;
  }
}

function gatedTool(): Tool {
  return {
    name: "gated-tool",
    description: "a consequential test tool",
    inputSchema: {},
    requiresApproval: true,
    execute: (input) => `did it: ${JSON.stringify(input)}`,
  };
}

function buildDeps(provider: ModelProvider, extraTools: readonly Tool[] = []): CliDeps {
  const registry = new Registry();
  registry.registerProvider(provider);
  for (const tool of extraTools) registry.registerTool(tool);
  dispatcherPack.register(registry);
  registry.registerAgent({
    name: "helper",
    providerName: "claude",
    model: "n/a",
    systemPrompt: "You help.",
    toolNames: extraTools.map((t) => t.name),
    description: "Helps with things.",
  });

  return {
    registry,
    store: new InMemoryRunStore(),
    workflowStore: new InMemoryWorkflowStore(),
    cwd: process.cwd(),
    inkboxClient: new FakeInkboxClient(),
    forwardingLog: new InMemoryForwardingLog(),
    messageEventLog: new InMemoryMessageEventLog(),
    coworkerStore: new InMemoryCoworkerTaskStore(),
    stdout: () => {},
    stderr: () => {},
  };
}

function captureOutput(deps: CliDeps): { stdout: string[]; stderr: string[]; deps: CliDeps } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, deps: { ...deps, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) } };
}

test("dispatch run plans and executes a single-step workflow end to end, reporting success", async () => {
  const provider = new ScriptedProvider("claude", [
    { content: '```json\n[{"agent": "helper", "task": "say hi"}]\n```', toolCalls: [], stopReason: "end_turn" },
    { content: "hi there!", toolCalls: [], stopReason: "end_turn" },
  ]);
  const { stdout, deps } = captureOutput(buildDeps(provider));

  const code = await runCli(["dispatch", "run", "--task", "greet someone"], deps);

  assert.equal(code, 0);
  const output = stdout.join("\n");
  assert.match(output, /succeeded/);
  assert.match(output, /hi there!/);
  const workflows = await deps.workflowStore.list();
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0]?.status, "succeeded");
});

test("dispatch run reports a planning failure clearly and persists the failed workflow", async () => {
  const provider = new ScriptedProvider("claude", [{ content: "I don't understand.", toolCalls: [], stopReason: "end_turn" }]);
  const { stderr, deps } = captureOutput(buildDeps(provider));

  const code = await runCli(["dispatch", "run", "--task", "do something vague"], deps);

  assert.equal(code, 1);
  assert.match(stderr.join("\n"), /Planning failed/);
  const workflows = await deps.workflowStore.list();
  assert.equal(workflows[0]?.status, "failed");
});

test("dispatch run pauses for approval, dispatch approve shows the pending action, and --yes completes it", async () => {
  const provider = new ScriptedProvider("claude", [
    { content: '```json\n[{"agent": "helper", "task": "do the consequential thing"}]\n```', toolCalls: [], stopReason: "end_turn" },
    { content: "proposing", toolCalls: [{ id: "call-1", toolName: "gated-tool", input: { x: 1 } }], stopReason: "tool_use" },
    { content: "all done", toolCalls: [], stopReason: "end_turn" },
  ]);
  const { stdout, deps } = captureOutput(buildDeps(provider, [gatedTool()]));

  const runCode = await runCli(["dispatch", "run", "--task", "do the thing"], deps);
  assert.equal(runCode, 0);
  const [workflow] = await deps.workflowStore.list();
  assert.equal(workflow?.status, "awaiting_approval");

  const reviewCode = await runCli(["dispatch", "approve", workflow!.id], deps);
  assert.equal(reviewCode, 0);
  assert.match(stdout.join("\n"), /gated-tool/);
  assert.match(stdout.join("\n"), /Re-run with --yes/);

  const approveCode = await runCli(["dispatch", "approve", workflow!.id, "--yes"], deps);
  assert.equal(approveCode, 0);
  const [updated] = await deps.workflowStore.list();
  assert.equal(updated?.status, "waiting_for_response");
});

test("dispatch status reports a not-found workflow clearly", async () => {
  const provider = new ScriptedProvider("claude", []);
  const { stderr, deps } = captureOutput(buildDeps(provider));

  const code = await runCli(["dispatch", "status", "no-such-id"], deps);

  assert.equal(code, 1);
  assert.match(stderr.join("\n"), /No workflow "no-such-id" found/);
});
