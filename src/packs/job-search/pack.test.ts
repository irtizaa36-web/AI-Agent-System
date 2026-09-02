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
import type { Tool } from "../../tools/tool";

function toolsFor(agentToolNames: readonly string[]): Map<string, Tool> {
  const jobBoardClient = new FakeBrowserClient("job-boards", new Map([["https://example-jobs.test/search", "Marketing Manager at Acme - Dallas, TX"]]));
  const all = new Map<string, Tool>([
    ["read-file", readFileTool],
    ["read-job-board-page", createReadJobBoardPageTool(jobBoardClient)],
  ]);
  return new Map(agentToolNames.map((name) => [name, all.get(name) as Tool]));
}

test("jobSearchPack registers job-search-agent with Claude, read-only tools only", () => {
  const registry = new Registry();

  jobSearchPack.register(registry);

  const agent = registry.getAgent("job-search-agent");
  assert.equal(agent.providerName, "claude");
  assert.deepEqual(agent.toolNames, ["read-file", "read-job-board-page"]);
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
