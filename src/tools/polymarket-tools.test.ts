import { test } from "node:test";
import assert from "node:assert/strict";
import { createPolymarketPlaceOrderTool } from "./polymarket-place-order";
import { createPolymarketPreviewOrderTool } from "./polymarket-preview-order";
import { FakePolymarketClient } from "../integrations/polymarket/fake-client";

const ORDER = {
  marketSlug: "chiefs-super-bowl-lx",
  intent: "ORDER_INTENT_BUY_LONG",
  type: "ORDER_TYPE_LIMIT",
  price: { value: "0.55", currency: "USD" },
  quantity: 100,
  tif: "TIME_IN_FORCE_GOOD_TILL_CANCEL",
};

test("polymarket-place-order always requires approval; the preview tool never does", () => {
  const client = new FakePolymarketClient();
  assert.equal(createPolymarketPlaceOrderTool(client).requiresApproval, true);
  assert.notEqual(createPolymarketPreviewOrderTool(client).requiresApproval, true);
});

test("preview reports the order and its notional without placing anything", async () => {
  const client = new FakePolymarketClient();
  const output = await createPolymarketPreviewOrderTool(client).execute(ORDER);

  assert.match(output, /placed:false/);
  assert.match(output, /notionalUSD:55\.00/);
  assert.equal(client.previewCalls.length, 1);
  assert.equal(client.placedCalls.length, 0);
});

test("place sends exactly the approved order and reports the order id", async () => {
  const client = new FakePolymarketClient();
  const output = await createPolymarketPlaceOrderTool(client).execute(ORDER);

  assert.deepEqual(client.placedCalls, [ORDER]);
  assert.match(output, /placed:true/);
  assert.match(output, /orderId:fake-order-1/);
});

test("invalid orders are rejected before reaching Polymarket", async () => {
  const client = new FakePolymarketClient();
  const tool = createPolymarketPlaceOrderTool(client);
  const invalid = [
    { ...ORDER, type: "ORDER_TYPE_MARKET" },
    { ...ORDER, price: { value: "1.00", currency: "USD" } },
    { ...ORDER, price: { value: "0", currency: "USD" } },
    { ...ORDER, price: { value: "abc", currency: "USD" } },
    { ...ORDER, quantity: 0 },
    { ...ORDER, quantity: 1.5 },
    { ...ORDER, intent: "ORDER_INTENT_YOLO" },
    { ...ORDER, tif: "TIME_IN_FORCE_GOOD_TILL_DATE" },
    { ...ORDER, marketSlug: " " },
  ];
  for (const input of invalid) {
    await assert.rejects(Promise.resolve().then(() => tool.execute(input)), Error, JSON.stringify(input));
  }
  assert.equal(client.placedCalls.length, 0);
});
