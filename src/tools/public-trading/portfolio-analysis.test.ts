import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseConcentration, analyseOrderFeasibility } from "./portfolio-analysis";
import type { OpenOrder, PortfolioSnapshot, Position } from "./types";

function position(symbol: string, currentValue: number, instrumentType = "CRYPTO"): Position {
  return {
    symbol,
    name: symbol,
    instrumentType,
    quantity: 1,
    openedAt: "2026-09-07T00:00:00Z",
    currentValue,
    percentOfPortfolio: 0,
    lastPrice: currentValue,
    totalCost: currentValue,
    unitCost: currentValue,
    unrealisedGain: 0,
    unrealisedGainRatio: 0,
  };
}

function buyOrder(symbol: string, notionalValue: number, status = "NEW"): OpenOrder {
  return {
    orderId: `o-${symbol}`,
    symbol,
    instrumentType: "EQUITY",
    side: "BUY",
    orderType: "LIMIT",
    status,
    createdAt: "2026-09-09T02:56:14Z",
    notionalValue,
    filledQuantity: 0,
  };
}

function snapshot(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    accountId: "5OI24720",
    accountType: "BROKERAGE",
    buyingPower: 14.91,
    cash: 146.6,
    totalAccountValue: 367.1,
    equity: [],
    positions: [],
    openOrders: [],
    ...overrides,
  };
}

test("analyseConcentration flags a single position over the threshold and sorts largest first", () => {
  const report = analyseConcentration(
    snapshot({ positions: [position("DOT", 53.05), position("AVAX", 87.9), position("ETH", 10.94)] }),
  );

  assert.deepEqual(
    report.positions.map((entry) => entry.symbol),
    ["AVAX", "DOT", "ETH"],
  );
  // AVAX is 23.9% of a $367.10 account, over the 20% single-position threshold.
  assert.equal(report.positions[0]!.flagged, true);
  assert.equal(report.positions[1]!.flagged, false);
  assert.ok(report.flags.some((flag) => flag.includes("AVAX")));
});

test("analyseConcentration flags the top-two pair the audit called out", () => {
  const report = analyseConcentration(snapshot({ positions: [position("AVAX", 87.9), position("DOT", 53.05)] }));

  // The briefing's finding: DOT + AVAX ~38% of a $367 account.
  assert.ok(Math.abs(report.topTwoCombinedShare - 0.384) < 0.005, `got ${report.topTwoCombinedShare}`);
  assert.ok(report.flags.some((flag) => flag.includes("AVAX") && flag.includes("DOT")));
});

test("analyseConcentration reports asset-class shares", () => {
  const report = analyseConcentration(
    snapshot({ positions: [position("AVAX", 87.9), position("MU", 2.78, "EQUITY")] }),
  );

  assert.equal(report.assetClassShares[0]!.type, "CRYPTO");
  assert.equal(report.assetClassShares[1]!.type, "EQUITY");
  assert.ok(report.assetClassShares[0]!.share > report.assetClassShares[1]!.share);
});

test("analyseConcentration stays quiet on a diversified account", () => {
  const report = analyseConcentration(
    snapshot({ positions: [position("A", 30), position("B", 30), position("C", 30)] }),
  );
  assert.deepEqual(report.flags, []);
});

test("analyseConcentration divides by zero safely on an empty account", () => {
  const report = analyseConcentration(snapshot({ totalAccountValue: 0, positions: [] }));
  assert.deepEqual(report.positions, []);
  assert.equal(report.topTwoCombinedShare, 0);
  assert.deepEqual(report.flags, []);
});

test("analyseOrderFeasibility reproduces the audit finding: ~$57 queued against $14.91", () => {
  const orders = [4.36, 3.7, 4.86, 4.08, 4.28, 5.09, 2.74, 1.88, 1.78, 3.09, 5.1, 2.04, 4.12, 4.02, 2.2, 3.35].map(
    (notional, index) => buyOrder(`SYM${index}`, notional),
  );
  const report = analyseOrderFeasibility(snapshot({ openOrders: orders }));

  assert.equal(report.openBuyOrderCount, 16);
  assert.equal(report.committedNotional, 56.69);
  assert.equal(report.shortfall, 41.78);
  assert.equal(report.infeasible, true);
  assert.ok(report.notes[0]!.includes("cannot all fill"));
});

test("analyseOrderFeasibility names orders too large to fill even on their own", () => {
  const report = analyseOrderFeasibility(snapshot({ buyingPower: 4, openOrders: [buyOrder("BIG", 10), buyOrder("OK", 2)] }));

  assert.equal(report.individuallyUnfillable.length, 1);
  assert.equal(report.individuallyUnfillable[0]!.symbol, "BIG");
  assert.ok(report.notes.some((note) => note.includes("BIG")));
});

test("analyseOrderFeasibility reports feasible when the queue fits inside buying power", () => {
  const report = analyseOrderFeasibility(snapshot({ buyingPower: 50, openOrders: [buyOrder("A", 10), buyOrder("B", 20)] }));

  assert.equal(report.infeasible, false);
  assert.equal(report.shortfall, -20);
  assert.ok(report.notes[0]!.includes("fit within"));
});

test("analyseOrderFeasibility ignores filled and cancelled orders and every sell", () => {
  const report = analyseOrderFeasibility(
    snapshot({
      openOrders: [
        buyOrder("FILLED", 100, "FILLED"),
        buyOrder("CANCELLED", 100, "CANCELLED"),
        { ...buyOrder("SELL", 100), side: "SELL" },
      ],
    }),
  );

  assert.equal(report.openBuyOrderCount, 0);
  assert.equal(report.committedNotional, 0);
  assert.equal(report.infeasible, false);
});
