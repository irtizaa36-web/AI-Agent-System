import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Registry } from "../registry/registry";
import { FakeProvider } from "../providers/fake";
import { InMemoryRunStore } from "../store/run-store";
import { InMemoryWorkflowStore } from "../store/workflow-store";
import { InMemoryConversationStore, JsonFileConversationStore } from "./conversation-store";
import { OrchestratorService } from "./orchestrator-service";

function registryWith(script: ConstructorParameters<typeof FakeProvider>[0]): Registry {
  const registry = new Registry();
  registry.registerProvider(new FakeProvider(script));
  registry.registerAgent({
    name: "dispatcher",
    providerName: "fake",
    model: "fake",
    systemPrompt: "Plan work as JSON.",
    toolNames: [],
    description: "Internal planner.",
  });
  registry.registerAgent({
    name: "worker",
    providerName: "fake",
    model: "fake",
    systemPrompt: "Complete delegated work.",
    toolNames: [],
    description: "Completes test work.",
  });
  return registry;
}

test("a message becomes a persisted workflow, real Agent Run, and linked assistant result", async () => {
  const conversationStore = new InMemoryConversationStore();
  const runStore = new InMemoryRunStore();
  const workflowStore = new InMemoryWorkflowStore();
  const service = new OrchestratorService({
    registry: registryWith([
      { content: '```json\n[{"agent":"worker","task":"Complete the requested goal"}]\n```', toolCalls: [], stopReason: "end_turn" },
      { content: "The delegated work is complete.", toolCalls: [], stopReason: "end_turn" },
    ]),
    runStore,
    workflowStore,
    conversationStore,
  });

  const response = await service.submit("Complete this goal");
  assert.equal(response.status, "succeeded");
  assert.match(response.content, /delegated work is complete/);
  assert.ok(response.workflowId);
  assert.equal((await workflowStore.load(response.workflowId))?.status, "succeeded");
  assert.equal((await runStore.list()).length, 1);

  const conversation = await service.getConversation();
  assert.deepEqual(conversation.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(conversation.messages[1]?.workflowId, response.workflowId);
});

test("planning failure is reported accurately and preserved in conversation history", async () => {
  const service = new OrchestratorService({
    registry: registryWith([]),
    runStore: new InMemoryRunStore(),
    workflowStore: new InMemoryWorkflowStore(),
    conversationStore: new InMemoryConversationStore(),
  });

  const response = await service.submit("Do something");
  assert.equal(response.status, "failed");
  assert.match(response.content, /Dispatcher run did not succeed/);
  assert.equal((await service.getConversation()).messages.length, 2);
});

test("JSON conversation history survives a new store instance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchestrator-conversation-"));
  const path = join(dir, "conversation.json");
  const first = new JsonFileConversationStore(path);
  const conversation = { id: "primary", messages: [], updatedAt: new Date().toISOString() };
  await first.save(conversation);

  assert.deepEqual(await new JsonFileConversationStore(path).load("primary"), conversation);
});
