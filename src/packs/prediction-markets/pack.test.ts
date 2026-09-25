import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../../registry/registry";
import { predictionMarketsPack } from "./pack";
import { createTask } from "../../core/task";
import { approveAndExecute, runToCompletion } from "../../core/orchestrator";
import { FakeProvider } from "../../providers/fake";
import { FakePolymarketClient } from "../../integrations/polymarket/fake-client";
import { createPolymarketFindMarketsTool } from "../../tools/polymarket-find-markets";
import { createPolymarketGetQuoteTool } from "../../tools/polymarket-get-quote";
import { createPolymarketPreviewOrderTool } from "../../tools/polymarket-preview-order";
import { createPolymarketPlaceOrderTool } from "../../tools/polymarket-place-order";
import type { Tool } from "../../tools/tool";

const ORDER = {
  marketSlug: "chiefs-super-bowl-lx",
  intent: "ORDER_INTENT_BUY_LONG",
  type: "ORDER_TYPE_LIMIT",
  price: { value: "0.40", currency: "USD" },
  quantity: 20,
  tif: "TIME_IN_FORCE_GOOD_TILL_CANCEL",
};

function toolsFor(client: FakePolymarketClient): Map<string, Tool> {
  return new Map<string, Tool>(
    [
      createPolymarketFindMarketsTool(client),
      createPolymarketGetQuoteTool(client),
      createPolymarketPreviewOrderTool(client),
      createPolymarketPlaceOrderTool(client),
    ].map((tool) => [tool.name, tool]),
  );
}

test("predictionMarketsPack registers polymarket-trader with only the Polymarket tools", () => {
  const registry = new Registry();
  predictionMarketsPack.register(registry);

  const agent = registry.getAgent("polymarket-trader");
  assert.equal(agent.providerName, "claude");
  assert.deepEqual(agent.toolNames, ["polymarket-find-markets", "polymarket-get-quote", "polymarket-preview-order", "polymarket-place-order"]);
  assert.match(agent.systemPrompt, /Never invent or guess a marketSlug/);
  assert.match(agent.systemPrompt, /Never split one request into several orders/);
  assert.ok(agent.description);
});

test("polymarket-trader pauses before placing, and the order goes through only after approval", async () => {
  const registry = new Registry();
  predictionMarketsPack.register(registry);
  const agent = registry.getAgent("polymarket-trader");

  const client = new FakePolymarketClient(
    [{ eventTitle: "Super Bowl LX", marketSlug: "chiefs-super-bowl-lx", marketTitle: "Chiefs", outcome: "Yes", active: true, closed: false }],
    new Map([["chiefs-super-bowl-lx", { marketSlug: "chiefs-super-bowl-lx", bestBid: "0.39", bestAsk: "0.41" }]]),
  );
  const tools = toolsFor(client);
  const provider = new FakeProvider([
    { content: "", toolCalls: [{ id: "c1", toolName: "polymarket-find-markets", input: { query: "Chiefs Super Bowl" } }], stopReason: "tool_use" },
    { content: "", toolCalls: [{ id: "c2", toolName: "polymarket-get-quote", input: { marketSlug: "chiefs-super-bowl-lx" } }], stopReason: "tool_use" },
    { content: "", toolCalls: [{ id: "c3", toolName: "polymarket-preview-order", input: ORDER }], stopReason: "tool_use" },
    { content: "Proposing the order.", toolCalls: [{ id: "c4", toolName: "polymarket-place-order", input: ORDER }], stopReason: "tool_use" },
    { content: "## Status\nPlaced: orderId fake-order-1.", toolCalls: [], stopReason: "end_turn" },
  ]);

  const paused = await runToCompletion(createTask("Buy $8 of Chiefs to win the Super Bowl"), agent, { provider, tools });

  assert.equal(paused.status, "awaiting_approval");
  assert.equal(paused.pendingAction?.toolName, "polymarket-place-order");
  assert.equal(client.previewCalls.length, 1);
  assert.equal(client.placedCalls.length, 0, "nothing is placed before a human approves");

  const approved = await approveAndExecute(paused, { tools }, ORDER);
  assert.notEqual(approved.status, "awaiting_approval");
  assert.deepEqual(client.placedCalls, [ORDER]);
});
