import { test } from "node:test";
import assert from "node:assert/strict";
import { agentStatusFileId, createAgentStatus } from "./agent-status";

test("createAgentStatus rejects an empty name", () => {
  assert.throws(() => createAgentStatus("  ", "idle"), /must not be empty/);
});

test("createAgentStatus defaults updatedAt to now and leaves currentTask undefined when omitted", () => {
  const before = Date.now();
  const status = createAgentStatus("Coordinator", "idle");
  assert.equal(status.name, "Coordinator");
  assert.equal(status.status, "idle");
  assert.equal(status.currentTask, undefined);
  assert.ok(Date.parse(status.updatedAt) >= before);
});

test("agentStatusFileId is filesystem-safe and case-insensitive", () => {
  assert.equal(agentStatusFileId("macmini"), "macmini");
  assert.equal(agentStatusFileId("Laptop2"), "laptop2");
  assert.equal(agentStatusFileId("Coordinator"), "coordinator");
});
