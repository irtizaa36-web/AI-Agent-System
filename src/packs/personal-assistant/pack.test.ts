import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../../registry/registry";
import { personalAssistantPack } from "./pack";
import { createTask } from "../../core/task";
import { runToCompletion } from "../../core/orchestrator";
import { FakeProvider } from "../../providers/fake";
import { readFileTool } from "../../tools/read-file";
import { FakeInkboxClient } from "../../integrations/inkbox/fake-client";
import { createInkboxSearchMailTool } from "../../tools/inkbox-search-mail";
import { createInkboxReadThreadTool } from "../../tools/inkbox-read-thread";
import { createInkboxSaveDraftTool } from "../../tools/inkbox-save-draft";
import { createSendEmailTool } from "../../tools/send-email";
import { createReadWebPageTool } from "../../tools/read-web-page";
import { FakeBrowserClient } from "../../integrations/browser/fake-client";
import type { Tool } from "../../tools/tool";

function toolsFor(agentToolNames: readonly string[]): Map<string, Tool> {
  const client = new FakeInkboxClient();
  const all = new Map<string, Tool>([
    ["read-file", readFileTool],
    ["inkbox-search-mail", createInkboxSearchMailTool(client)],
    ["inkbox-read-thread", createInkboxReadThreadTool(client)],
    ["inkbox-save-draft", createInkboxSaveDraftTool(client)],
    ["send-email", createSendEmailTool(client)],
    ["read-web-page", createReadWebPageTool(new FakeBrowserClient("sermo"))],
  ]);
  return new Map(agentToolNames.map((name) => [name, all.get(name) as Tool]));
}

test("personalAssistantPack registers personal-admin with Claude, read-file, and the Inkbox tools including gated send-email", () => {
  const registry = new Registry();

  personalAssistantPack.register(registry);

  const agent = registry.getAgent("personal-admin");
  assert.equal(agent.providerName, "claude");
  assert.equal(agent.model, "claude-sonnet-5");
  assert.deepEqual(agent.toolNames, [
    "read-file",
    "inkbox-search-mail",
    "inkbox-read-thread",
    "inkbox-save-draft",
    "send-email",
    "read-web-page",
  ]);
  assert.match(agent.systemPrompt, /Requires your approval/);
  assert.match(agent.systemPrompt, /never take real-world action yourself/i);
  assert.match(agent.systemPrompt, /send-email tool is never executed by you automatically/);
  assert.match(agent.systemPrompt, /read-web-page tool/);
  assert.match(agent.systemPrompt, /no way to click, type, submit a form/);
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
    tools: toolsFor(agent.toolNames),
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
    tools: toolsFor(agent.toolNames),
  });

  assert.equal(run.status, "succeeded");
  assert.match(run.result?.output ?? "", /nothing has been booked/);
});

test("personal-admin pauses in awaiting_approval if it ever calls send-email, never sending automatically", async () => {
  const registry = new Registry();
  personalAssistantPack.register(registry);
  const agent = registry.getAgent("personal-admin");

  const provider = new FakeProvider([
    {
      content: "I've drafted the inquiry and would like to send it.",
      toolCalls: [
        {
          id: "call-1",
          toolName: "send-email",
          input: {
            to: [{ address: "reservations@example-restaurant.test" }],
            subject: "Reservation inquiry",
            body: "Table for 13, Friday evening.",
            bcc: [],
            draftId: "draft-1",
            revision: "rev-1",
          },
        },
      ],
      stopReason: "tool_use",
    },
  ]);

  const run = await runToCompletion(createTask("Send the reservation inquiry."), agent, {
    provider,
    tools: toolsFor(agent.toolNames),
  });

  assert.equal(run.status, "awaiting_approval");
  assert.equal(run.pendingAction?.toolName, "send-email");
});
