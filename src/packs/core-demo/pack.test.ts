import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../../registry/registry";
import { coreDemoPack } from "./pack";

test("coreDemoPack registers the default and demo agents", () => {
  const registry = new Registry();

  coreDemoPack.register(registry);

  const names = registry
    .listAgents()
    .map((agent) => agent.name)
    .sort();
  assert.deepEqual(names, ["default", "demo", "inkbox-send"]);
  assert.equal(registry.getAgent("default").providerName, "claude");
  assert.equal(registry.getAgent("demo").providerName, "fake");
  assert.deepEqual(registry.getAgent("inkbox-send").toolNames, ["send-email"]);
});
