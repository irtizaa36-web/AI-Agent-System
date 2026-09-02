import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../../registry/registry";
import { careerAdvisorPack } from "./pack";
import { createTask } from "../../core/task";
import { runToCompletion } from "../../core/orchestrator";
import { FakeProvider } from "../../providers/fake";
import { readFileTool } from "../../tools/read-file";
import { FakeInkboxClient } from "../../integrations/inkbox/fake-client";
import { createInkboxSaveDraftTool } from "../../tools/inkbox-save-draft";
import { createSendEmailTool } from "../../tools/send-email";
import type { Tool } from "../../tools/tool";

function toolsFor(agentToolNames: readonly string[]): Map<string, Tool> {
  const client = new FakeInkboxClient();
  const all = new Map<string, Tool>([
    ["read-file", readFileTool],
    ["inkbox-save-draft", createInkboxSaveDraftTool(client)],
    ["send-email", createSendEmailTool(client)],
  ]);
  return new Map(agentToolNames.map((name) => [name, all.get(name) as Tool]));
}

test("careerAdvisorPack registers career-advisor with Claude, read-file, and the gated send-email tool", () => {
  const registry = new Registry();

  careerAdvisorPack.register(registry);

  const agent = registry.getAgent("career-advisor");
  assert.equal(agent.providerName, "claude");
  assert.equal(agent.model, "claude-sonnet-5");
  assert.deepEqual(agent.toolNames, ["read-file", "inkbox-save-draft", "send-email"]);
  assert.match(agent.systemPrompt, /never invent, embellish, or assume any credential/);
  assert.match(agent.systemPrompt, /October 23, 2026/);
  assert.match(agent.systemPrompt, /discuss why you think the applicant would benefit from the Chrysalis Project program/);
  assert.match(agent.systemPrompt, /2nd-year resident/);
  assert.match(agent.systemPrompt, /Never draft the recommendation letter itself/);
  assert.match(agent.systemPrompt, /you have no ability to do it/);
  assert.ok(agent.description);
});

test("career-advisor drafts a personal statement section from a fake provider's structured response", async () => {
  const registry = new Registry();
  careerAdvisorPack.register(registry);
  const agent = registry.getAgent("career-advisor");

  const provider = new FakeProvider([
    {
      content:
        "## Requirements Checklist\nAAAAI membership: not started. Personal statement: in progress. CV: not started. Faculty letter: not started. Deadline: October 23, 2026.\n\n" +
        "## Missing Information\nNeed publication details and chosen faculty member.\n\n" +
        "## Status\nThis is preparation only. Nothing has been submitted to AAAAI, no letter has been requested, and no faculty member has been contacted.",
      toolCalls: [],
      stopReason: "end_turn",
    },
  ]);

  const task = createTask("Help me start my Chrysalis Project application. I did a case report on eosinophilic esophagitis as a second author.");
  const run = await runToCompletion(task, agent, { provider, tools: toolsFor(agent.toolNames) });

  assert.equal(run.status, "succeeded");
  assert.match(run.result?.output ?? "", /## Requirements Checklist/);
  assert.match(run.result?.output ?? "", /preparation only/);
});

test("career-advisor pauses in awaiting_approval if it ever calls send-email, never sending the faculty request automatically", async () => {
  const registry = new Registry();
  careerAdvisorPack.register(registry);
  const agent = registry.getAgent("career-advisor");

  const provider = new FakeProvider([
    {
      content: "I've drafted the request to your faculty mentor and would like to send it.",
      toolCalls: [
        {
          id: "call-1",
          toolName: "send-email",
          input: {
            to: [{ address: "mentor@example-hospital.test" }],
            subject: "Chrysalis Project letter of recommendation",
            body: "Would you be willing to write my Chrysalis Project letter?",
            bcc: [],
            draftId: "draft-1",
            revision: "rev-1",
          },
        },
      ],
      stopReason: "tool_use",
    },
  ]);

  const run = await runToCompletion(createTask("Send the request to my mentor."), agent, {
    provider,
    tools: toolsFor(agent.toolNames),
  });

  assert.equal(run.status, "awaiting_approval");
  assert.equal(run.pendingAction?.toolName, "send-email");
});
