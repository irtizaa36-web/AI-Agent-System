import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCandidates, optionUnderlyingsFor, parseWatchlistConfig } from "./candidates";
import type { PortfolioSnapshot } from "../public-trading/types";

function snapshot(
  positions: readonly { symbol: string; weight: number; type?: string }[],
): PortfolioSnapshot {
  return {
    accountId: "5OI24720",
    accountType: "BROKERAGE",
    buyingPower: 2.2,
    cash: 2.2,
    totalAccountValue: 747.94,
    equity: [],
    openOrders: [],
    positions: positions.map((position) => ({
      symbol: position.symbol,
      name: position.symbol,
      instrumentType: position.type ?? "EQUITY",
      quantity: 1,
      openedAt: "2026-09-10T20:00:00Z",
      currentValue: position.weight * 747.94,
      percentOfPortfolio: position.weight,
      lastPrice: 1,
      totalCost: 1,
      unitCost: 1,
      unrealisedGain: 0,
      unrealisedGainRatio: 0,
    })),
  };
}

test("parseWatchlistConfig normalises tickers and drops duplicates", () => {
  const config = parseWatchlistConfig({ tickers: ["spy", "SPY", " qqq "] });
  assert.deepEqual(config.tickers, ["SPY", "QQQ"]);
});

test("parseWatchlistConfig rejects an OSI contract where an underlying belongs", () => {
  assert.throws(
    () => parseWatchlistConfig({ tickers: ["IOVA261016C00012500"] }),
    /name underlyings, not contracts/,
  );
});

test("parseWatchlistConfig rejects a malformed config rather than silently emptying it", () => {
  assert.throws(() => parseWatchlistConfig(null), /must be an object/);
  assert.throws(() => parseWatchlistConfig({}), /"tickers" array/);
  assert.throws(() => parseWatchlistConfig({ tickers: ["SPY", ""] }), /non-empty strings/);
});

test("parseWatchlistConfig keeps optionUnderlyings and notes, keyed upper-case", () => {
  const config = parseWatchlistConfig({
    tickers: ["spy"],
    optionUnderlyings: ["spy"],
    notes: { spy: "primary 0DTE vehicle" },
  });
  assert.deepEqual(config.optionUnderlyings, ["SPY"]);
  assert.equal(config.notes?.["SPY"], "primary 0DTE vehicle");
});

test("parseWatchlistConfig reads the real committed watchlist file shape", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile("config/market-review-watchlist.json", "utf-8"));
  const config = parseWatchlistConfig(raw);
  assert.ok(config.tickers.includes("SPY"), "SPY should be on the committed watchlist");
  assert.deepEqual(config.optionUnderlyings, ["SPY"]);
});

test("buildCandidates merges holdings, watchlist and scan hits, keeping every source", () => {
  const candidates = buildCandidates({
    snapshot: snapshot([{ symbol: "MU", weight: 0.134 }]),
    watchlist: { tickers: ["MU", "SPY"], notes: { SPY: "0DTE vehicle" } },
    scanHits: [{ symbol: "MU", note: "up 6% on 3x volume" }, { symbol: "TSLA", note: "gap up on delivery beat" }],
  });

  const mu = candidates.find((candidate) => candidate.symbol === "MU");
  assert.deepEqual(mu?.sources, ["HOLDING", "WATCHLIST", "MARKET_SCAN"]);
  assert.equal(mu?.portfolioWeight, 0.134);
  assert.match(mu?.note ?? "", /up 6% on 3x volume/);

  const spy = candidates.find((candidate) => candidate.symbol === "SPY");
  assert.deepEqual(spy?.sources, ["WATCHLIST"]);
  assert.equal(spy?.note, "0DTE vehicle");
});

test("buildCandidates orders holdings first by weight, then watchlist, then scan-only", () => {
  const candidates = buildCandidates({
    snapshot: snapshot([
      { symbol: "NVDA", weight: 0.13 },
      { symbol: "MU", weight: 0.14 },
    ]),
    watchlist: { tickers: ["SPY", "QQQ"] },
    scanHits: [{ symbol: "TSLA", note: "mover" }],
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.symbol),
    ["MU", "NVDA", "QQQ", "SPY", "TSLA"],
  );
});

test("buildCandidates skips option positions, which are not underlyings", () => {
  const candidates = buildCandidates({
    snapshot: snapshot([
      { symbol: "IOVA261016C00012500", weight: 0.024, type: "OPTION" },
      { symbol: "IOVA", weight: 0.006 },
    ]),
  });
  assert.deepEqual(
    candidates.map((candidate) => candidate.symbol),
    ["IOVA"],
  );
});

test("buildCandidates applies a minimum holding weight when asked", () => {
  const candidates = buildCandidates({
    snapshot: snapshot([
      { symbol: "MU", weight: 0.134 },
      { symbol: "NG", weight: 0.0029 },
    ]),
    minPortfolioWeight: 0.02,
  });
  assert.deepEqual(
    candidates.map((candidate) => candidate.symbol),
    ["MU"],
  );
});

test("buildCandidates returns an empty list when given nothing", () => {
  assert.deepEqual(buildCandidates({}), []);
});

test("optionUnderlyingsFor returns only configured underlyings that are candidates this run", () => {
  const candidates = buildCandidates({ watchlist: { tickers: ["SPY", "QQQ"] } });
  assert.deepEqual(optionUnderlyingsFor(candidates, { tickers: ["SPY", "QQQ"], optionUnderlyings: ["SPY"] }), ["SPY"]);
  assert.deepEqual(
    optionUnderlyingsFor(candidates, { tickers: [], optionUnderlyings: ["TSLA"] }),
    [],
    "configured but not a candidate today",
  );
});

test("optionUnderlyingsFor pulls no chains when none are configured", () => {
  const candidates = buildCandidates({ watchlist: { tickers: ["SPY", "QQQ", "NVDA"] } });
  assert.deepEqual(optionUnderlyingsFor(candidates, { tickers: ["SPY"] }), []);
  assert.deepEqual(optionUnderlyingsFor(candidates, undefined), []);
});
