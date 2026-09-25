import { test } from "node:test";
import assert from "node:assert/strict";
import { createPolymarketPlaceOrderTool } from "./polymarket-place-order";
import { createPolymarketPreviewOrderTool } from "./polymarket-preview-order";
import { createPolymarketFindMarketsTool } from "./polymarket-find-markets";
import { createPolymarketGetQuoteTool } from "./polymarket-get-quote";
import { FakePolymarketClient } from "../integrations/polymarket/fake-client";

async function withCap<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const original = process.env["POLYMARKET_MAX_ORDER_USD"];
  try {
    if (value === undefined) delete process.env["POLYMARKET_MAX_ORDER_USD"];
    else process.env["POLYMARKET_MAX_ORDER_USD"] = value;
    return await fn();
  } finally {
    if (original === undefined) delete process.env["POLYMARKET_MAX_ORDER_USD"];
    else process.env["POLYMARKET_MAX_ORDER_USD"] = original;
  }
}

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

test("preview reports the order and its notional without placing anything", () => withCap("100", async () => {
  const client = new FakePolymarketClient();
  const output = await createPolymarketPreviewOrderTool(client).execute(ORDER);

  assert.match(output, /placed:false/);
  assert.match(output, /notionalUSD:55\.00/);
  assert.equal(client.previewCalls.length, 1);
  assert.equal(client.placedCalls.length, 0);
}));

test("place sends exactly the approved order and reports the order id", () => withCap("100", async () => {
  const client = new FakePolymarketClient();
  const output = await createPolymarketPlaceOrderTool(client).execute(ORDER);

  assert.deepEqual(client.placedCalls, [ORDER]);
  assert.match(output, /placed:true/);
  assert.match(output, /orderId:fake-order-1/);
}));

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

test("orders over the default $10 cap are refused by both preview and place", () =>
  withCap(undefined, async () => {
    const client = new FakePolymarketClient();
    for (const tool of [createPolymarketPreviewOrderTool(client), createPolymarketPlaceOrderTool(client)]) {
      await assert.rejects(Promise.resolve().then(() => tool.execute(ORDER)), /over the \$10\.00 per-order cap/);
    }
    assert.equal(client.previewCalls.length + client.placedCalls.length, 0);
    await createPolymarketPlaceOrderTool(client).execute({ ...ORDER, quantity: 18 }); // $9.90
    assert.equal(client.placedCalls.length, 1);
  }));

test("an unparseable or non-positive cap falls back to $10, never to unlimited", async () => {
  for (const value of ["", "abc", "0", "-5"]) {
    await withCap(value, async () => {
      const client = new FakePolymarketClient();
      await assert.rejects(Promise.resolve().then(() => createPolymarketPlaceOrderTool(client).execute(ORDER)), /\$10\.00/, value);
    });
  }
});

test("lowering the cap after approval still blocks the order at execution time", () =>
  withCap("100", async () => {
    const client = new FakePolymarketClient();
    const tool = createPolymarketPlaceOrderTool(client);
    process.env["POLYMARKET_MAX_ORDER_USD"] = "20";
    await assert.rejects(Promise.resolve().then(() => tool.execute(ORDER)), /\$20\.00/);
    assert.equal(client.placedCalls.length, 0);
  }));

test("find-markets lists real slugs; get-quote reports the book", async () => {
  const client = new FakePolymarketClient(
    [{ eventTitle: "Super Bowl LX", marketSlug: "chiefs-super-bowl-lx", marketTitle: "Chiefs", outcome: "Yes", active: true, closed: false }],
    new Map([["chiefs-super-bowl-lx", { marketSlug: "chiefs-super-bowl-lx", bestBid: "0.54", bestAsk: "0.56" }]]),
  );

  assert.match(await createPolymarketFindMarketsTool(client).execute({ query: "chiefs" }), /marketSlug:chiefs-super-bowl-lx/);
  assert.match(await createPolymarketFindMarketsTool(client).execute({ query: "eagles" }), /No active markets/);
  const quote = await createPolymarketGetQuoteTool(client).execute({ marketSlug: "chiefs-super-bowl-lx" });
  assert.match(quote, /bestAsk:0\.56/);
  assert.match(quote, /buyYesPrice\(longQuote\):\(none\)/);
  assert.match(quote, /lastTrade:\(none\)/);
});

test("a SHORT order counts the worse of its Yes/No prices against the cap", () =>
  withCap("10", async () => {
    const client = new FakePolymarketClient();
    const tool = createPolymarketPlaceOrderTool(client);
    // 20 × 0.25 = $5 if the price were the No price, but 20 × 0.75 = $15 if it's the Yes price.
    const short = { ...ORDER, intent: "ORDER_INTENT_BUY_SHORT", price: { value: "0.25", currency: "USD" }, quantity: 20 };
    await assert.rejects(Promise.resolve().then(() => tool.execute(short)), /\$15\.00/);
    await tool.execute({ ...short, intent: "ORDER_INTENT_BUY_LONG" }); // $5, fine
    assert.equal(client.placedCalls.length, 1);
  }));
