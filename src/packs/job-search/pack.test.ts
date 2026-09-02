import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../../registry/registry";
import { jobSearchPack } from "./pack";
import { createTask } from "../../core/task";
import { runToCompletion } from "../../core/orchestrator";
import { FakeProvider } from "../../providers/fake";
import { readFileTool } from "../../tools/read-file";
import { createReadJobBoardPageTool } from "../../tools/read-job-board-page";
import { FakeBrowserClient } from "../../integrations/browser/fake-client";
import { FakeInkboxClient } from "../../integrations/inkbox/fake-client";
import { createInkboxSearchMailTool } from "../../tools/inkbox-search-mail";
import { createInkboxReadThreadTool } from "../../tools/inkbox-read-thread";
import type { Tool } from "../../tools/tool";

function toolsFor(agentToolNames: readonly string[], inkboxClient: FakeInkboxClient = new FakeInkboxClient()): Map<string, Tool> {
  const jobBoardClient = new FakeBrowserClient("job-boards", new Map([["https://example-jobs.test/search", "Marketing Manager at Acme - Dallas, TX"]]));
  const all = new Map<string, Tool>([
    ["read-file", readFileTool],
    ["read-job-board-page", createReadJobBoardPageTool(jobBoardClient)],
    ["inkbox-search-mail", createInkboxSearchMailTool(inkboxClient)],
    ["inkbox-read-thread", createInkboxReadThreadTool(inkboxClient)],
  ]);
  return new Map(agentToolNames.map((name) => [name, all.get(name) as Tool]));
}

test("jobSearchPack registers job-search-agent with Claude, read-only tools only", () => {
  const registry = new Registry();

  jobSearchPack.register(registry);

  const agent = registry.getAgent("job-search-agent");
  assert.equal(agent.providerName, "claude");
  assert.deepEqual(agent.toolNames, ["read-file", "read-job-board-page", "inkbox-search-mail", "inkbox-read-thread"]);
  assert.match(agent.systemPrompt, /no ability to apply to a job, contact an employer, or submit anything/);
  assert.match(agent.systemPrompt, /never invent a title, employer, metric, responsibility, or skill/);
  assert.ok(agent.description);
  assert.match(agent.description ?? "", /Cannot apply to anything/);
});

test("job-search-agent produces a structured jobs-found report from a fake provider's response", async () => {
  const registry = new Registry();
  jobSearchPack.register(registry);
  const agent = registry.getAgent("job-search-agent");

  const provider = new FakeProvider([
    {
      content:
        "## Jobs Found\n- Marketing Manager at Acme, Dallas, TX - Strong fit.\n\n## Tailored Resume(s)\nNot needed - the one job found was a strong fit as-is.\n\n## Missing Information\nNone.\n\n## Status\nInformational only. No application was submitted and no employer was contacted.",
      toolCalls: [],
      stopReason: "end_turn",
    },
  ]);

  const task = createTask("Find marketing jobs in Dallas using https://example-jobs.test/search, matched against my resume.");
  const run = await runToCompletion(task, agent, { provider, tools: toolsFor(agent.toolNames) });

  assert.equal(run.status, "succeeded");
  assert.match(run.result?.output ?? "", /## Jobs Found/);
  assert.match(run.result?.output ?? "", /No application was submitted/);
});

test("job-search-agent can read a forwarded job-alert email as a second listing source", async () => {
  const registry = new Registry();
  jobSearchPack.register(registry);
  const agent = registry.getAgent("job-search-agent");

  const inkboxClient = new FakeInkboxClient("toozy@inkboxmail.com");
  inkboxClient.receiveInbound({
    id: "alert-1",
    threadId: "thread-alert-1",
    from: { address: "jobs-noreply@linkedin.com" },
    to: [{ address: "toozy@inkboxmail.com" }],
    subject: "New jobs for you: marketing program manager",
    body: "Marketing Program Manager - Acme Corp - Dallas, TX\nSenior Marketing Manager - Globex - Remote",
    receivedAt: new Date().toISOString(),
  });

  const provider = new FakeProvider([
    {
      content: "searching mailbox for alerts",
      toolCalls: [{ id: "call-1", toolName: "inkbox-search-mail", input: { query: "linkedin" } }],
      stopReason: "tool_use",
    },
    {
      content: "reading the alert thread",
      toolCalls: [{ id: "call-2", toolName: "inkbox-read-thread", input: { threadId: "thread-alert-1" } }],
      stopReason: "tool_use",
    },
    {
      content:
        "## Jobs Found\n- Marketing Program Manager, Acme Corp, Dallas, TX - Possible fit.\n- Senior Marketing Manager, Globex, Remote - Possible fit.\n\n## Tailored Resume(s)\nSkipped for this test.\n\n## Missing Information\nNone.\n\n## Status\nInformational only. No application was submitted, no employer was contacted.",
      toolCalls: [],
      stopReason: "end_turn",
    },
  ]);

  const task = createTask("Check the mailbox for LinkedIn job-alert emails and assess fit against my resume.");
  const run = await runToCompletion(task, agent, { provider, tools: toolsFor(agent.toolNames, inkboxClient) });

  assert.equal(run.status, "succeeded");
  assert.match(run.result?.output ?? "", /Acme Corp/);
  assert.match(run.result?.output ?? "", /Globex/);
});
