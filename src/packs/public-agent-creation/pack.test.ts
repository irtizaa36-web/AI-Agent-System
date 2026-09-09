import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../../registry/registry";
import { publicAgentCreationPack } from "./pack";
import { createTask } from "../../core/task";
import { runToCompletion } from "../../core/orchestrator";
import { FakeProvider } from "../../providers/fake";

test("public-agent-creation registers a Claude design-only agent with no tools", () => {
  const registry = new Registry();

  publicAgentCreationPack.register(registry);

  const agent = registry.getAgent("public-agent-builder");
  assert.equal(agent.providerName, "claude");
  assert.deepEqual(agent.toolNames, []);
  assert.match(agent.systemPrompt, /Do not publish, enable, install, authenticate/);
  assert.match(agent.systemPrompt, /## Tools and Permissions/);
  assert.match(agent.systemPrompt, /## Publish Checklist/);
  assert.match(agent.description ?? "", /Never publishes/);
});

test("public-agent-builder preserves the publication boundary in its result contract", async () => {
  const registry = new Registry();
  publicAgentCreationPack.register(registry);
  const agent = registry.getAgent("public-agent-builder");

  const provider = new FakeProvider([
    {
      content:
        "## Agent Profile\nA portable job-search review agent.\n\n## System Prompt\nCopy-ready prompt.\n\n## Tools and Permissions\nNo tools are needed.\n\n## Test Cases\nSuccess, missing input, and unsafe request cases.\n\n## Publish Checklist\nReview, test, approve, then publish manually.\n\n## Missing Information\nTarget platform is not specified.\n\n## Status\nDesign package only. Nothing was published, enabled, installed, authenticated, or sent.",
      toolCalls: [],
      stopReason: "end_turn",
    },
  ]);

  const run = await runToCompletion(createTask("Design a public agent that evaluates job-search results."), agent, {
    provider,
    tools: new Map(),
  });

  assert.equal(run.status, "succeeded");
  assert.match(run.result?.output ?? "", /## Agent Profile/);
  assert.match(run.result?.output ?? "", /Nothing was published/);
});
