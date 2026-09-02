import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDefaultConfig } from "./load";

test("loadDefaultConfig wires up engine providers/tools plus the enabled packs' agents", () => {
  const registry = loadDefaultConfig();

  assert.equal(registry.getProvider("claude").name, "claude");
  assert.equal(registry.getProvider("fake").name, "fake");
  assert.equal(registry.getTool("read-file").name, "read-file");

  const names = registry
    .listAgents()
    .map((agent) => agent.name)
    .sort();
  assert.deepEqual(names, ["default", "demo"]);
});
