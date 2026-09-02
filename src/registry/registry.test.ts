import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "./registry";
import { createEchoProvider } from "../providers/fake";
import { readFileTool } from "../tools/read-file";

test("Registry round-trips a registered agent", () => {
  const registry = new Registry();
  registry.registerAgent({
    name: "demo",
    providerName: "fake",
    model: "fake-1",
    systemPrompt: "hi",
    toolNames: [],
  });

  assert.equal(registry.getAgent("demo").model, "fake-1");
  assert.equal(registry.listAgents().length, 1);
});

test("Registry.getAgent throws a helpful error listing available agents", () => {
  const registry = new Registry();
  registry.registerAgent({
    name: "demo",
    providerName: "fake",
    model: "fake-1",
    systemPrompt: "hi",
    toolNames: [],
  });

  assert.throws(() => registry.getAgent("missing"), /Unknown agent "missing"\. Available: demo/);
});

test("Registry.toolMapFor builds a map from an agent's declared tool names", () => {
  const registry = new Registry();
  registry.registerTool(readFileTool);

  const tools = registry.toolMapFor(["read-file"]);

  assert.equal(tools.get("read-file"), readFileTool);
});

test("Registry.getProvider resolves a registered provider by its own name", () => {
  const registry = new Registry();
  const provider = createEchoProvider();
  registry.registerProvider(provider);

  assert.equal(registry.getProvider(provider.name), provider);
});

test("Registry.listProviders and listTools report everything registered", () => {
  const registry = new Registry();
  registry.registerProvider(createEchoProvider());
  registry.registerTool(readFileTool);

  assert.equal(registry.listProviders().length, 1);
  assert.equal(registry.listTools().length, 1);
  assert.equal(registry.listTools()[0], readFileTool);
});

test("Registry.registerPack and listPacks track loaded packs without duplicates", () => {
  const registry = new Registry();
  registry.registerPack("core-demo");
  registry.registerPack("core-demo");
  registry.registerPack("ai-research");

  assert.deepEqual(registry.listPacks(), ["core-demo", "ai-research"]);
});
