import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseHistoryPage, normalisePortfolio, normalisePreflight, normaliseTransaction } from "./client";
import { createPublicTradingClient, unwrapMcpResult, type PublicReadToolName } from "./mcp-client";

/** A trimmed copy of a real `get_portfolio` response, shapes and string-typed numbers intact. */
const RAW_PORTFOLIO = {
  accountId: "5OI24720",
  accountType: "BROKERAGE",
  buyingPower: { cashOnlyBuyingPower: "14.91", buyingPower: "14.91", optionsBuyingPower: "0.00" },
  equity: [
    { type: "CASH", value: "146.60", percentageOfPortfolio: "39.93" },
    { type: "CRYPTO", value: "187.80", percentageOfPortfolio: "51.16" },
  ],
  positions: [
    {
      instrument: { symbol: "AVAX", name: "Avalanche", type: "CRYPTO" },
      quantity: "10.94222267",
      openedAt: "2026-09-07T02:30:34.901172+00:00",
      currentValue: "87.90",
      percentOfPortfolio: "23.94",
      lastPrice: { lastPrice: "8.03", timestamp: "2026-09-09T07:43:18+00:00" },
      instrumentGain: { gainValue: "-0.02", gainPercentage: "-0.22" },
      costBasis: { totalCost: "86.33", unitCost: "7.89", gainValue: "1.60", gainPercentage: "1.85" },
    },
  ],
  orders: [
    {
      orderId: "0e589c26",
      instrument: { symbol: "ARIS", type: "EQUITY" },
      createdAt: "2026-09-09T02:56:14.267015+00:00",
      type: "LIMIT",
      side: "BUY",
      status: "NEW",
      notionalValue: "4.36",
      limitPrice: "21.00",
      filledQuantity: "0",
    },
  ],
  cash: "146.60",
  totalAccountValue: "367.10",
};

test("normalisePortfolio parses string decimals and unwraps the nested buyingPower", () => {
  const snapshot = normalisePortfolio(RAW_PORTFOLIO);

  assert.equal(snapshot.accountId, "5OI24720");
  assert.equal(snapshot.buyingPower, 14.91);
  assert.equal(snapshot.totalAccountValue, 367.1);
  assert.equal(snapshot.cash, 146.6);
  assert.equal(snapshot.positions.length, 1);
  assert.equal(snapshot.openOrders.length, 1);
  assert.equal(snapshot.openOrders[0]!.notionalValue, 4.36);
});

test("normalisePortfolio converts the API's whole-number percentages into ratios", () => {
  const snapshot = normalisePortfolio(RAW_PORTFOLIO);
  assert.ok(Math.abs(snapshot.positions[0]!.percentOfPortfolio - 0.2394) < 1e-9);
  assert.ok(Math.abs(snapshot.equity[0]!.percentOfPortfolio - 0.3993) < 1e-9);
});

test("normalisePosition derives position P/L from costBasis, not the misleading instrumentGain", () => {
  const position = normalisePortfolio(RAW_PORTFOLIO).positions[0]!;
  // instrumentGain says -0.22%; the position is actually +1.85% against cost.
  assert.equal(position.unrealisedGain, 1.6);
  assert.ok(position.unrealisedGainRatio > 0.018 && position.unrealisedGainRatio < 0.019);
});

test("normalisePortfolio throws with the field name when a required number is missing", () => {
  assert.throws(
    () => normalisePortfolio({ ...RAW_PORTFOLIO, totalAccountValue: undefined }),
    /totalAccountValue/,
  );
});

test("normaliseTransaction keeps principal and net distinct so drag stays measurable", () => {
  const transaction = normaliseTransaction({
    id: "d9d7e542",
    timestamp: "2026-09-08T03:15:35.494055+00:00",
    type: "TRADE",
    subType: "TRADE",
    symbol: "UNI",
    securityType: "CRYPTO",
    side: "BUY",
    description: "BUY 5.287224 UNI at 6.998",
    netAmount: "-37.22",
    principalAmount: "-36.999993552",
    quantity: "5.287224",
    fees: "0.00",
  });

  assert.equal(transaction.netAmount, -37.22);
  assert.ok(Math.abs(transaction.principalAmount - -36.999993552) < 1e-9);
  assert.equal(transaction.fees, 0);
  assert.equal(transaction.side, "BUY");
});

test("unwrapMcpResult parses the connector's double-encoded {result: '<json>'} envelope", () => {
  assert.deepEqual(unwrapMcpResult({ result: '{"cash":"1.00"}' }), { cash: "1.00" });
  assert.deepEqual(unwrapMcpResult('{"cash":"1.00"}'), { cash: "1.00" });
  assert.deepEqual(unwrapMcpResult({ result: { cash: "1.00" } }), { cash: "1.00" });
});

test("normaliseHistoryPage surfaces the pagination cursor and drops an empty one", () => {
  assert.equal(normaliseHistoryPage({ transactions: [], nextToken: "abc" }).nextToken, "abc");
  assert.equal(normaliseHistoryPage({ transactions: [], nextToken: "" }).nextToken, undefined);
  assert.equal(normaliseHistoryPage({ transactions: [] }).nextToken, undefined);
});

test("getHistory follows nextToken to exhaustion rather than stopping on a short page", async () => {
  // The real connector returned 2 transactions for page_size 6 *and* a cursor:
  // page size counts raw account events, which are filtered out of the array.
  const pages = [
    { transactions: [{ id: "t1", timestamp: "2026-09-08T00:00:00Z", type: "TRADE" }], nextToken: "cursor-1" },
    { transactions: [{ id: "t2", timestamp: "2026-09-08T01:00:00Z", type: "TRADE" }], nextToken: "cursor-2" },
    { transactions: [{ id: "t3", timestamp: "2026-09-08T02:00:00Z", type: "TRADE" }] },
  ];
  let call = 0;
  const client = createPublicTradingClient(async () => ({ result: JSON.stringify(pages[call++]) }));

  const transactions = await client.getHistory("5OI24720", { start: "2026-09-08T00:00:00Z" });
  assert.equal(transactions.length, 3);
  assert.equal(call, 3);
});

test("getHistory de-duplicates transactions repeated across pages", async () => {
  const pages = [
    { transactions: [{ id: "t1", timestamp: "2026-09-08T00:00:00Z", type: "TRADE" }], nextToken: "cursor-1" },
    { transactions: [{ id: "t1", timestamp: "2026-09-08T00:00:00Z", type: "TRADE" }] },
  ];
  let call = 0;
  const client = createPublicTradingClient(async () => ({ result: JSON.stringify(pages[call++]) }));

  assert.equal((await client.getHistory("5OI24720")).length, 1);
});

test("getHistory stops rather than looping forever on a connector that repeats its cursor", async () => {
  let calls = 0;
  const client = createPublicTradingClient(async () => {
    calls += 1;
    return { result: JSON.stringify({ transactions: [{ id: `t${calls}`, type: "TRADE" }], nextToken: "same" }) };
  });

  await client.getHistory("5OI24720");
  assert.ok(calls <= 50, `expected the page guard to cap the loop, made ${calls} calls`);
});

test("the client only ever names read tools and preflight_order — never place_order", async () => {
  const named: PublicReadToolName[] = [];
  const client = createPublicTradingClient(async (toolName) => {
    named.push(toolName);
    return { result: JSON.stringify({ transactions: [], accepted: true }) };
  });

  await client.getHistory("acct");
  await client.preflightOrder("acct", {
    symbol: "DOT",
    instrumentType: "CRYPTO",
    side: "BUY",
    orderType: "LIMIT",
    amount: 5,
    limitPrice: 1.2,
  });

  assert.deepEqual(named, ["get_history", "preflight_order"]);
  assert.ok(!named.some((tool) => String(tool).includes("place")));
  // The interface offers no execution method at all, which is the real
  // guarantee — reaching for one needs an `unknown` cast to compile, because
  // `PublicTradingClient` has no index signature to probe.
  assert.equal((client as unknown as Record<string, unknown>)["placeOrder"], undefined);
});

test("preflightOrder sends amount and quantity as the mutually exclusive fields the API expects", async () => {
  let sent: Record<string, unknown> = {};
  const client = createPublicTradingClient(async (_tool, args) => {
    sent = args;
    return { result: JSON.stringify({ accepted: true }) };
  });

  await client.preflightOrder("acct", {
    symbol: "DOT",
    instrumentType: "CRYPTO",
    side: "BUY",
    orderType: "LIMIT",
    amount: 5,
    limitPrice: 1.23,
  });

  assert.equal(sent["amount"], "5.00");
  assert.equal(sent["limit_price"], "1.23");
  assert.equal(sent["quantity"], undefined);
  assert.equal(sent["order_side"], "BUY");
});

test("normalisePreflight treats an error message or explicit rejection as not accepted", () => {
  assert.equal(normalisePreflight({ accepted: true, orderValue: "5.00" }).accepted, true);
  assert.equal(normalisePreflight({ accepted: false }).accepted, false);
  assert.equal(normalisePreflight({ error: "insufficient buying power" }).accepted, false);
  assert.equal(normalisePreflight({ status: "REJECTED" }).accepted, false);
  assert.equal(normalisePreflight({ error: "nope" }).message, "nope");
});
