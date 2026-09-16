import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addTradingDays,
  candidatesToCheck,
  catalystsInWindow,
  groupCatalystsBySymbol,
  partitionMacro,
  tradingDaysBetween,
} from "./catalysts";
import type { Candidate, CatalystFlag } from "./types";

test("tradingDaysBetween counts same-day as zero and the next weekday as one", () => {
  assert.equal(tradingDaysBetween("2026-09-16", "2026-09-16"), 0);
  assert.equal(tradingDaysBetween("2026-09-16", "2026-09-17"), 1);
});

test("tradingDaysBetween skips the weekend", () => {
  // 2026-09-18 is a Friday; the next trading day is Monday the 21st.
  assert.equal(tradingDaysBetween("2026-09-18", "2026-09-21"), 1);
  // Friday to the following Friday is five trading days, not seven.
  assert.equal(tradingDaysBetween("2026-09-18", "2026-09-25"), 5);
});

test("tradingDaysBetween skips supplied holidays", () => {
  const holidays = ["2026-09-17"];
  assert.equal(tradingDaysBetween("2026-09-16", "2026-09-18", holidays), 1);
});

test("tradingDaysBetween returns a negative count for a past date", () => {
  assert.equal(tradingDaysBetween("2026-09-17", "2026-09-16"), -1);
  assert.equal(tradingDaysBetween("2026-09-21", "2026-09-18"), -1, "across a weekend");
});

test("addTradingDays walks forward over weekends and holidays", () => {
  assert.equal(addTradingDays("2026-09-18", 1), "2026-09-21", "Friday + 1 is Monday");
  assert.equal(addTradingDays("2026-09-16", 5), "2026-09-23");
  assert.equal(addTradingDays("2026-09-16", 1, ["2026-09-17"]), "2026-09-18");
  assert.equal(addTradingDays("2026-09-16", 0), "2026-09-16");
});

test("catalystsInWindow keeps events inside the window and annotates the distance", () => {
  const found = catalystsInWindow({
    runDate: "2026-09-16",
    events: [
      { symbol: "MU", kind: "EARNINGS", date: "2026-09-18", detail: "Q4 earnings, after close" },
      { symbol: "NVDA", kind: "DIVIDEND", date: "2026-09-21", detail: "Ex-dividend" },
    ],
  });

  assert.equal(found.length, 2);
  assert.equal(found[0]?.symbol, "MU");
  assert.equal(found[0]?.tradingDaysAway, 2);
  assert.equal(found[1]?.tradingDaysAway, 3);
});

test("catalystsInWindow drops events beyond the window", () => {
  const found = catalystsInWindow({
    runDate: "2026-09-16",
    events: [{ symbol: "AMD", kind: "EARNINGS", date: "2026-10-30", detail: "Q3 earnings" }],
    windowTradingDays: 5,
  });
  assert.deepEqual(found, []);
});

test("catalystsInWindow drops past events rather than reporting a negative distance", () => {
  const found = catalystsInWindow({
    runDate: "2026-09-16",
    events: [{ symbol: "AAPL", kind: "EARNINGS", date: "2026-09-14", detail: "Already reported" }],
  });
  assert.deepEqual(found, [], "a past print is context, not an upcoming catalyst");
});

test("catalystsInWindow keeps a same-day event", () => {
  const found = catalystsInWindow({
    runDate: "2026-09-16",
    events: [{ symbol: "SPY", kind: "MACRO", date: "2026-09-16", detail: "FOMC decision 14:00 ET" }],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.tradingDaysAway, 0);
});

test("catalystsInWindow sorts nearest first, then by symbol, and normalises case", () => {
  const found = catalystsInWindow({
    runDate: "2026-09-16",
    events: [
      { symbol: "zeta", kind: "EARNINGS", date: "2026-09-18", detail: "b" },
      { symbol: "abcl", kind: "EARNINGS", date: "2026-09-18", detail: "a" },
      { symbol: "mu", kind: "EARNINGS", date: "2026-09-17", detail: "c" },
    ],
  });
  assert.deepEqual(
    found.map((catalyst) => catalyst.symbol),
    ["MU", "ABCL", "ZETA"],
  );
});

test("candidatesToCheck defaults to every candidate", () => {
  const candidates: Candidate[] = [
    { symbol: "MU", sources: ["HOLDING"], portfolioWeight: 0.13 },
    { symbol: "NG", sources: ["HOLDING"], portfolioWeight: 0.003 },
  ];
  assert.equal(candidatesToCheck(candidates).length, 2);
  assert.equal(candidatesToCheck(candidates, 0).length, 2);
});

test("candidatesToCheck drops only small holdings, never watchlist or scan names", () => {
  const candidates: Candidate[] = [
    { symbol: "MU", sources: ["HOLDING"], portfolioWeight: 0.13 },
    { symbol: "NG", sources: ["HOLDING"], portfolioWeight: 0.003 },
    { symbol: "SPY", sources: ["WATCHLIST"] },
    { symbol: "TSLA", sources: ["MARKET_SCAN"] },
    // A small holding that is also on the watchlist stays: the watchlist is an
    // explicit instruction to look at it.
    { symbol: "IOVA", sources: ["HOLDING", "WATCHLIST"], portfolioWeight: 0.006 },
  ];

  const checked = candidatesToCheck(candidates, 0.02).map((candidate) => candidate.symbol);
  assert.deepEqual(checked, ["MU", "SPY", "TSLA", "IOVA"]);
});

test("groupCatalystsBySymbol groups while preserving order within a symbol", () => {
  const catalysts: CatalystFlag[] = [
    { symbol: "MU", kind: "EARNINGS", date: "2026-09-17", tradingDaysAway: 1, detail: "earnings" },
    { symbol: "MU", kind: "DIVIDEND", date: "2026-09-18", tradingDaysAway: 2, detail: "ex-div" },
    { symbol: "NVDA", kind: "SPLIT", date: "2026-09-18", tradingDaysAway: 2, detail: "split" },
  ];
  const grouped = groupCatalystsBySymbol(catalysts);
  assert.equal(grouped.size, 2);
  assert.deepEqual(grouped.get("MU")?.map((catalyst) => catalyst.kind), ["EARNINGS", "DIVIDEND"]);
});

test("partitionMacro separates book-wide events from per-name ones", () => {
  const catalysts: CatalystFlag[] = [
    { symbol: "SPY", kind: "MACRO", date: "2026-09-16", tradingDaysAway: 0, detail: "CPI" },
    { symbol: "MU", kind: "EARNINGS", date: "2026-09-17", tradingDaysAway: 1, detail: "earnings" },
  ];
  const { macro, perSymbol } = partitionMacro(catalysts);
  assert.equal(macro.length, 1);
  assert.equal(perSymbol.length, 1);
  assert.equal(macro[0]?.detail, "CPI");
});
