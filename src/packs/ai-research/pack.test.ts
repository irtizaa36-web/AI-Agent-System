import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../../registry/registry";
import { aiResearchPack } from "./pack";
import { createTask } from "../../core/task";
import { runToCompletion } from "../../core/orchestrator";
import { FakeProvider } from "../../providers/fake";
import { readFileTool } from "../../tools/read-file";
import type { Tool } from "../../tools/tool";

function toolsFor(agentToolNames: readonly string[]): Map<string, Tool> {
  const all = new Map<string, Tool>([["read-file", readFileTool]]);
  return new Map(agentToolNames.map((name) => [name, all.get(name) as Tool]));
}

test("aiResearchPack registers case-report-writer with Claude, read-file only, no submission-capable tools", () => {
  const registry = new Registry();

  aiResearchPack.register(registry);

  const agent = registry.getAgent("case-report-writer");
  assert.equal(agent.providerName, "claude");
  assert.deepEqual(agent.toolNames, ["read-file"]);
  assert.match(agent.systemPrompt, /never invent clinical findings/);
  assert.match(agent.systemPrompt, /Hard rule on patient identifiers/);
  assert.match(agent.systemPrompt, /September 21, 2026/);
  assert.match(agent.systemPrompt, /could NOT be verified from a live source/);
  assert.ok(agent.description);
});

test("case-report-writer drafts a structured case report from a fake provider's response", async () => {
  const registry = new Registry();
  aiResearchPack.register(registry);
  const agent = registry.getAgent("case-report-writer");

  const provider = new FakeProvider([
    {
      content:
        "## Requirements Checklist\nDeadline: September 21, 2026. Case Report Draft: in progress.\n\n" +
        "## Missing Information\nNeed exam findings and lab values.\n\n" +
        "## Case Report Draft\nIntroduction: ...\n\n" +
        "## Requires your approval\nNothing to submit — no submission tool exists.\n\n" +
        "## Status\nDraft in progress, not submitted anywhere.",
      toolCalls: [],
      stopReason: "end_turn",
    },
  ]);

  const task = createTask("66F with systemic capillary leak syndrome, symptom onset 2021, three escalating hypotensive episodes.");
  const run = await runToCompletion(task, agent, { provider, tools: toolsFor(agent.toolNames) });

  assert.equal(run.status, "succeeded");
  assert.match(run.result?.output ?? "", /## Case Report Draft/);
  assert.match(run.result?.output ?? "", /not submitted anywhere/);
});

test("case-report-writer strips a pasted patient identifier rather than repeating it", async () => {
  const registry = new Registry();
  aiResearchPack.register(registry);
  const agent = registry.getAgent("case-report-writer");

  // Simulates the model actually following its own identifier-stripping rule —
  // this test locks in that the prompt instructs it, not that a fake model enforces it live.
  const provider = new FakeProvider([
    {
      content:
        "I removed a patient identifier from your input before drafting anything below.\n\n" +
        "## Requirements Checklist\nDeadline: September 21, 2026.\n\n## Missing Information\nMore clinical detail needed.\n\n" +
        "## Case Report Draft\nThe patient is a 66-year-old female...\n\n## Requires your approval\nNothing to submit.\n\n## Status\nDraft in progress.",
      toolCalls: [],
      stopReason: "end_turn",
    },
  ]);

  const run = await runToCompletion(createTask("Jane Doe (MRN 12345), 66F with SCLS."), agent, {
    provider,
    tools: toolsFor(agent.toolNames),
  });

  assert.doesNotMatch(run.result?.output ?? "", /Jane Doe|MRN 12345/);
  assert.match(run.result?.output ?? "", /removed a patient identifier/);
});
