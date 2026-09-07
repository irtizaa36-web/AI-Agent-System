import { test } from "node:test";
import assert from "node:assert/strict";
import { applyConstraints } from "./apply-constraints";
import type { AgentDefinition } from "./agent";

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { name: "test-agent", providerName: "fake", model: "fake-model", systemPrompt: "Be helpful.", toolNames: [], ...overrides };
}

test("applyConstraints prepends a non-empty block to the system prompt", () => {
  const result = applyConstraints(agent(), "Correction: always cite sources.\n\n");

  assert.equal(result.systemPrompt, "Correction: always cite sources.\n\nBe helpful.");
});

test("applyConstraints is a no-op for an empty block", () => {
  const original = agent();
  const result = applyConstraints(original, "");

  assert.equal(result, original);
});

test("applyConstraints leaves every other Agent field untouched", () => {
  const original = agent({ toolNames: ["read-file"], maxSteps: 5 });
  const result = applyConstraints(original, "note\n\n");

  assert.equal(result.name, original.name);
  assert.equal(result.providerName, original.providerName);
  assert.equal(result.model, original.model);
  assert.deepEqual(result.toolNames, original.toolNames);
  assert.equal(result.maxSteps, original.maxSteps);
});
