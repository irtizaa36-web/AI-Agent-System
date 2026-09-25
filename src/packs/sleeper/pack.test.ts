import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../../registry/registry";
import { sleeperPack } from "./pack";
import { createTask } from "../../core/task";
import { approveAndExecute, runToCompletion } from "../../core/orchestrator";
import { FakeProvider } from "../../providers/fake";
import { loadDefaultConfig } from "../../config/load";
import { FakeSleeperWriteClient } from "../../integrations/sleeper/fake-write-client";
import { InMemoryPickemStore } from "../../sleeper/pickem/store";
import { fixtureClient, LEAGUE_ID } from "../../sleeper/test-fixtures";

const LINEUP = { kind: "set_lineup", leagueId: LEAGUE_ID, rosterId: 1, starters: ["11", "12", "19", "14", "20", "16", "17", "18", "KC"] };

function registryWithFakes(writeClient = new FakeSleeperWriteClient()) {
  const registry = loadDefaultConfig(undefined, undefined, undefined, undefined, undefined, undefined, {
    readClient: fixtureClient(),
    writeClient,
    pickemStore: new InMemoryPickemStore(),
  });
  return { registry, writeClient };
}

test("sleeperPack registers the manager (with the gated write) and a pick'em researcher with no write tools", () => {
  const registry = new Registry();
  sleeperPack.register(registry);

  const manager = registry.getAgent("sleeper-manager");
  assert.deepEqual(manager.toolNames, ["sleeper-find-leagues", "sleeper-matchup-preview", "sleeper-waiver-recommendations", "sleeper-preview-write", "sleeper-execute-write"]);
  assert.match(manager.systemPrompt, /Never guess a username, league id/);

  const researcher = registry.getAgent("pickem-researcher");
  assert.deepEqual(researcher.toolNames, ["pickem-research-line", "pickem-bankroll-status", "pickem-build-slip"]);
  assert.match(researcher.systemPrompt, /You cannot place entries/);
  assert.match(researcher.systemPrompt, /Never 100%/);
  assert.match(researcher.systemPrompt, /Skip weak days/);
});

test("no registered tool can place a pick'em entry, and the researcher's tools are all non-consequential", () => {
  const { registry } = registryWithFakes();
  for (const tool of registry.listTools()) {
    assert.doesNotMatch(tool.name, /pick.?em.*(place|submit|enter)|(place|submit|enter).*pick.?em/i, tool.name);
  }
  const tools = registry.toolMapFor(registry.getAgent("pickem-researcher").toolNames);
  for (const tool of tools.values()) assert.notEqual(tool.requiresApproval, true, tool.name);
});

test("sleeper-manager pauses before a write, and the write goes through only after exact approval", async () => {
  const { registry, writeClient } = registryWithFakes();
  const agent = registry.getAgent("sleeper-manager");
  const tools = registry.toolMapFor(agent.toolNames);
  const provider = new FakeProvider([
    { content: "", toolCalls: [{ id: "c1", toolName: "sleeper-find-leagues", input: { username: "owner_one" } }], stopReason: "tool_use" },
    { content: "", toolCalls: [{ id: "c2", toolName: "sleeper-matchup-preview", input: { username: "owner_one", leagueId: LEAGUE_ID } }], stopReason: "tool_use" },
    { content: "", toolCalls: [{ id: "c3", toolName: "sleeper-preview-write", input: { action: LINEUP } }], stopReason: "tool_use" },
    { content: "Proposing the lineup fix.", toolCalls: [{ id: "c4", toolName: "sleeper-execute-write", input: { action: LINEUP, confirm: true } }], stopReason: "tool_use" },
    { content: "## Status\nwritten:true", toolCalls: [], stopReason: "end_turn" },
  ]);

  const paused = await runToCompletion(createTask("Fix my lineup for this week, username owner_one"), agent, { provider, tools });
  assert.equal(paused.status, "awaiting_approval");
  assert.equal(paused.pendingAction?.toolName, "sleeper-execute-write");
  assert.equal(writeClient.executed.length, 0, "nothing is written before the owner approves");

  await assert.rejects(approveAndExecute(paused, { tools }, { action: { ...LINEUP, rosterId: 2 }, confirm: true }), /does not match/);
  assert.equal(writeClient.executed.length, 0);

  const approved = await approveAndExecute(paused, { tools }, { action: LINEUP, confirm: true });
  assert.notEqual(approved.status, "awaiting_approval");
  assert.equal(writeClient.executed.length, 1);
});
