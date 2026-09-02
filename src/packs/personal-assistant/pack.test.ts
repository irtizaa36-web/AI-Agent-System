import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../../registry/registry";
import { personalAssistantPack } from "./pack";
import { createTask } from "../../core/task";
import { runToCompletion } from "../../core/orchestrator";
import { FakeProvider } from "../../providers/fake";
import { readFileTool } from "../../tools/read-file";

test("personalAssistantPack registers personal-admin with Claude and read-file", () => {
  const registry = new Registry();

  personalAssistantPack.register(registry);

  const agent = registry.getAgent("personal-admin");
  assert.equal(agent.providerName, "claude");
  assert.equal(agent.model, "claude-sonnet-5");
  assert.deepEqual(agent.toolNames, ["read-file"]);
  assert.match(agent.systemPrompt, /Requires your approval/);
  assert.match(agent.systemPrompt, /never take real-world action yourself/i);
});

test("personal-admin runs a return task through to a Result via runToCompletion, using a fake provider", async () => {
  const registry = new Registry();
  personalAssistantPack.register(registry);
  const agent = registry.getAgent("personal-admin");

  const provider = new FakeProvider([
    {
      content:
        "## Understanding\nYou want help returning defective headphones bought from Best Buy 18 days ago.\n\n## Status\nThis is planning/drafting only. Nothing has been sent, submitted, or booked.",
      toolCalls: [],
      stopReason: "end_turn",
    },
  ]);

  const task = createTask(
    "I bought headphones from Best Buy 18 days ago. They're defective. Figure out my options and draft what to say to customer service.",
  );

  const run = await runToCompletion(task, agent, {
    provider,
    tools: new Map([["read-file", readFileTool]]),
  });

  assert.equal(run.status, "succeeded");
  assert.match(run.result?.output ?? "", /## Status/);
  assert.match(run.result?.output ?? "", /planning\/drafting only/);
});

test("personal-admin runs a reservation task through to a Result via runToCompletion, using a fake provider", async () => {
  const registry = new Registry();
  personalAssistantPack.register(registry);
  const agent = registry.getAgent("personal-admin");

  const provider = new FakeProvider([
    {
      content:
        "## Understanding\nYou want a reservation for 13 people in Houston.\n\n## Status\nThis is planning/drafting only. No restaurant has been contacted and nothing has been booked.",
      toolCalls: [],
      stopReason: "end_turn",
    },
  ]);

  const task = createTask("Find or contact a Houston restaurant for a group of 13 people.");

  const run = await runToCompletion(task, agent, {
    provider,
    tools: new Map([["read-file", readFileTool]]),
  });

  assert.equal(run.status, "succeeded");
  assert.match(run.result?.output ?? "", /nothing has been booked/);
});
