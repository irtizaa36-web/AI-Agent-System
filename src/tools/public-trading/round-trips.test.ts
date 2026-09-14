import { test } from "node:test";
import assert from "node:assert/strict";
import { fillCost, matchRoundTrips, roundTripsClosedAfter, summariseRoundTrips } from "./round-trips";
import type { Transaction } from "./types";

function trade(overrides: Partial<Transaction> & Pick<Transaction, "id" | "timestamp" | "symbol" | "side">): Transaction {
  return {
    type: "TRADE",
    subType: "TRADE",
    securityType: "CRYPTO",
    description: "",
    netAmount: 0,
    principalAmount: 0,
    quantity: 0,
    fees: 0,
    ...overrides,
  } as Transaction;
}

test("fillCost measures the gap between principal and net on a buy, even with zero stated fees", () => {
  // The real UNI buy of 2026-09-08: $37.00 of principal moved $37.22 of cash.
  const cost = fillCost(
    { transactionId: "t1", timestamp: "2026-09-08T03:15:35Z", quantity: 5.287224, netAmount: -37.22, principalAmount: -36.999993552, fees: 0 },
    "BUY",
  );
  assert.ok(Math.abs(cost - 0.22) < 0.001, `expected ~0.22 of drag, got ${cost}`);
});

test("fillCost on a sell counts proceeds withheld, not extra paid", () => {
  const cost = fillCost(
    { transactionId: "t2", timestamp: "2026-09-08T09:00:00Z", quantity: 1, netAmount: 39.58, principalAmount: 39.8, fees: 0 },
    "SELL",
  );
  assert.ok(Math.abs(cost - 0.22) < 0.001, `expected ~0.22 of drag, got ${cost}`);
});

test("matchRoundTrips pairs a buy with a later sell and computes realised P/L", () => {
  const trips = matchRoundTrips([
    trade({ id: "b1", timestamp: "2026-09-05T00:00:00Z", symbol: "BTC", side: "BUY", quantity: 1, netAmount: -40.24, principalAmount: -40.0 }),
    trade({ id: "s1", timestamp: "2026-09-05T00:30:00Z", symbol: "BTC", side: "SELL", quantity: 1, netAmount: 39.58, principalAmount: 39.8 }),
  ]);

  assert.equal(trips.length, 1);
  const trip = trips[0]!;
  assert.equal(trip.symbol, "BTC");
  // The briefing's BTC #1: bought $40.24, sold $39.58, net -$0.66.
  assert.ok(Math.abs(trip.realisedPl - -0.66) < 0.001, `got ${trip.realisedPl}`);
  assert.ok(Math.abs(trip.holdHours - 0.5) < 0.001);
  // Price moved -0.5% but the position lost 1.64% — the gap is drag.
  assert.ok(trip.priceMoveRatio < 0 && trip.realisedPlRatio < trip.priceMoveRatio);
  assert.ok(Math.abs(trip.costDragDollars - 0.46) < 0.001, `got ${trip.costDragDollars}`);
});

test("matchRoundTrips matches FIFO across multiple lots", () => {
  const trips = matchRoundTrips([
    trade({ id: "b1", timestamp: "2026-09-01T00:00:00Z", symbol: "ETH", side: "BUY", quantity: 1, netAmount: -10, principalAmount: -10 }),
    trade({ id: "b2", timestamp: "2026-09-02T00:00:00Z", symbol: "ETH", side: "BUY", quantity: 1, netAmount: -20, principalAmount: -20 }),
    trade({ id: "s1", timestamp: "2026-09-03T00:00:00Z", symbol: "ETH", side: "SELL", quantity: 1, netAmount: 15, principalAmount: 15 }),
  ]);

  assert.equal(trips.length, 1);
  // FIFO: the $10 lot is closed first, so this is a +$5 win, not a -$5 loss.
  assert.equal(trips[0]!.realisedPl, 5);
  assert.deepEqual(trips[0]!.buyTransactionIds, ["b1"]);
  assert.equal(trips[0]!.openedAt, "2026-09-01T00:00:00Z");
});

test("matchRoundTrips handles a partial close against one lot", () => {
  const trips = matchRoundTrips([
    trade({ id: "b1", timestamp: "2026-09-01T00:00:00Z", symbol: "AVAX", side: "BUY", quantity: 10, netAmount: -100, principalAmount: -100 }),
    trade({ id: "s1", timestamp: "2026-09-04T00:00:00Z", symbol: "AVAX", side: "SELL", quantity: 4, netAmount: 44, principalAmount: 44 }),
  ]);

  assert.equal(trips.length, 1);
  assert.equal(trips[0]!.quantity, 4);
  // Only the cost of the 4 units sold counts: $40 in, $44 out.
  assert.equal(trips[0]!.costIn, 40);
  assert.equal(trips[0]!.realisedPl, 4);
});

test("matchRoundTrips leaves the remainder of a lot open for a later sell", () => {
  const trips = matchRoundTrips([
    trade({ id: "b1", timestamp: "2026-09-01T00:00:00Z", symbol: "DOT", side: "BUY", quantity: 10, netAmount: -100, principalAmount: -100 }),
    trade({ id: "s1", timestamp: "2026-09-02T00:00:00Z", symbol: "DOT", side: "SELL", quantity: 4, netAmount: 44, principalAmount: 44 }),
    trade({ id: "s2", timestamp: "2026-09-03T00:00:00Z", symbol: "DOT", side: "SELL", quantity: 6, netAmount: 54, principalAmount: 54 }),
  ]);

  assert.equal(trips.length, 2);
  assert.equal(trips[1]!.costIn, 60);
  assert.equal(trips[1]!.realisedPl, -6);
});

test("matchRoundTrips ignores a sell with no matching buy rather than inventing a cost basis", () => {
  const trips = matchRoundTrips([
    trade({ id: "s1", timestamp: "2026-09-03T00:00:00Z", symbol: "SOL", side: "SELL", quantity: 1, netAmount: 7.86, principalAmount: 7.9 }),
  ]);
  assert.equal(trips.length, 0);
});

test("matchRoundTrips ignores non-trade transactions such as deposits", () => {
  const trips = matchRoundTrips([
    trade({ id: "d1", timestamp: "2026-09-01T00:00:00Z", symbol: "", side: "BUY", type: "MONEY_MOVEMENT", netAmount: 100 } as never),
    trade({ id: "b1", timestamp: "2026-09-02T00:00:00Z", symbol: "BTC", side: "BUY", quantity: 1, netAmount: -2.01, principalAmount: -2.0 }),
    trade({ id: "s1", timestamp: "2026-09-02T00:15:00Z", symbol: "BTC", side: "SELL", quantity: 1, netAmount: 1.98, principalAmount: 2.0 }),
  ]);
  assert.equal(trips.length, 1);
  assert.ok(Math.abs(trips[0]!.realisedPl - -0.03) < 0.001);
});

test("matchRoundTrips sorts out-of-order transactions before matching", () => {
  const trips = matchRoundTrips([
    trade({ id: "s1", timestamp: "2026-09-05T00:30:00Z", symbol: "BTC", side: "SELL", quantity: 1, netAmount: 39.58, principalAmount: 39.8 }),
    trade({ id: "b1", timestamp: "2026-09-05T00:00:00Z", symbol: "BTC", side: "BUY", quantity: 1, netAmount: -40.24, principalAmount: -40.0 }),
  ]);
  assert.equal(trips.length, 1);
  assert.ok(trips[0]!.holdHours > 0);
});

test("summariseRoundTrips reports the briefing's realised record: 4 losses, 1 win", () => {
  const summary = summariseRoundTrips([
    { realisedPl: -0.14, realisedPlRatio: -0.0175, costIn: 8, costDragDollars: 0.06, holdHours: 3 },
    { realisedPl: -0.66, realisedPlRatio: -0.0164, costIn: 40.24, costDragDollars: 0.46, holdHours: 0.5 },
    { realisedPl: -0.57, realisedPlRatio: -0.0189, costIn: 30.18, costDragDollars: 0.3, holdHours: 6 },
    { realisedPl: -0.03, realisedPlRatio: -0.0149, costIn: 2.01, costDragDollars: 0.03, holdHours: 0.25 },
    { realisedPl: 0.41, realisedPlRatio: 0.0061, costIn: 66.9, costDragDollars: 0.5, holdHours: 72 },
  ] as never);

  assert.equal(summary.count, 5);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 4);
  assert.ok(Math.abs(summary.totalRealisedPl - -0.99) < 0.001, `got ${summary.totalRealisedPl}`);
  assert.equal(summary.medianHoldHours, 3);
  // Dollar-weighted, so the $66.90 trade's drag is not averaged away by the $2.01 one.
  assert.ok(summary.meanCostDragRatio > 0 && summary.meanCostDragRatio < 0.02);
});

test("summariseRoundTrips returns zeroes rather than NaN for an empty set", () => {
  const summary = summariseRoundTrips([]);
  assert.equal(summary.count, 0);
  assert.equal(summary.winRate, 0);
  assert.equal(summary.meanCostDragRatio, 0);
  assert.equal(summary.medianHoldHours, 0);
});

test("roundTripsClosedAfter keeps only trips closed after the watermark", () => {
  const trips = [
    { closedAt: "2026-09-05T00:00:00Z" },
    { closedAt: "2026-09-07T00:00:00Z" },
  ] as never as Parameters<typeof roundTripsClosedAfter>[0];

  assert.equal(roundTripsClosedAfter(trips, "2026-09-06T00:00:00Z").length, 1);
  assert.equal(roundTripsClosedAfter(trips, undefined).length, 2);
  // An unparseable watermark must not silently drop every trip.
  assert.equal(roundTripsClosedAfter(trips, "not-a-date").length, 2);
});
