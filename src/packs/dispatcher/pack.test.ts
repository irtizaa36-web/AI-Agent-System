import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../../registry/registry";
import { dispatcherPack } from "./pack";

test("dispatcherPack registers a Dispatcher agent with no tools and a description marking it as internal", () => {
  const registry = new Registry();

  dispatcherPack.register(registry);

  const agent = registry.getAgent("dispatcher");
  assert.equal(agent.providerName, "claude");
  assert.deepEqual(agent.toolNames, []);
  assert.match(agent.description ?? "", /used internally/);
  assert.match(agent.systemPrompt, /fenced code block/);
  assert.match(agent.systemPrompt, /```json/);
  assert.match(agent.systemPrompt, /Never invent an agent name/);
});
