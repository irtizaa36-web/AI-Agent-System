import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMarketReview,
  parseCheckInSlot,
  priceDeltas,
  priorReferenceFrom,
  reviewSeverity,
  runLevelFlags,
} from "./review";
import { etClock } from "./analysis";
import type { UnderlyingQuote } from "./types";

const SIZING = { riskBudgetUsd: 500 } as const;

test("parseCheckInSlot accepts the four slots and rejects anything else", () => {
  assert.equal(parseCheckInSlot("pre-open"), "pre-open");
  assert.equal(parseCheckInSlot("PRE-CLOSE"), "pre-close");
  assert.throws(() => parseCheckInSlot("lunch"), /Unknown check-in slot/);
});

test("buildMarketReview derives the ET clock and minutes to close from runAt", () => {
  const review = buildMarketReview({
    runAt: "2026-09-16T19:30:00Z",
    slot: "pre-close",
    accountId: "5OI24720",
    sizing: SIZING,
  });
  assert.equal(review.clock.etTime, "15:30");
  assert.equal(review.minutesToClose, 30);
});

test("buildMarketReview splits macro catalysts out of the per-symbol list", () => {
  const review = buildMarketReview({
    runAt: "2026-09-16T13:00:00Z",
    slot: "pre-open",
    accountId: "5OI24720",
    sizing: SIZING,
    catalysts: [
      { symbol: "SPY", kind: "MACRO", date: "2026-09-16", tradingDaysAway: 0, detail: "FOMC 14:00 ET" },
      { symbol: "MU", kind: "EARNINGS", date: "2026-09-18", tradingDaysAway: 2, detail: "Q4" },
    ],
  });
  assert.equal(review.macroCatalysts.length, 1);
  assert.equal(review.symbolCatalysts.length, 1);
});

test("buildMarketReview aggregates contract and IV flags into one run-level list", () => {
  const review = buildMarketReview({
    // 16:00 UTC is 12:00 ET, the midday slot's own target, so no drift flag
    // competes with the two flags this test is about.
    runAt: "2026-09-16T16:00:00Z",
    slot: "midday",
    accountId: "5OI24720",
    sizing: SIZING,
    contractAnalyses: [
      {
        contract: { osiSymbol: "SPY260917C00660000", underlying: "SPY", side: "CALL", strike: 660, expiration: "2026-09-17" },
        underlyingPrice: 655,
        entryPrice: 2,
        entryBasis: "ASK",
        entryPricePerContract: 200,
        breakeven: 662,
        breakevenMoveRatio: 0.0107,
        priceFor2x: 664,
        moveRatioFor2x: 0.0137,
        priceForWorthless: 660,
        moveRatioForWorthless: 0.0076,
        flags: [{ code: "WIDE_SPREAD", severity: "WARN", message: "wide" }],
      },
    ],
    ivTermChecks: [
      {
        nearExpiration: "2026-09-17",
        farExpiration: "2026-09-18",
        comparisons: [],
        flags: [{ code: "IV_TERM_ANOMALY", severity: "WARN", message: "anomaly" }],
      },
    ],
  });

  assert.equal(review.flags.length, 2);
  assert.equal(reviewSeverity(review), "WARN");
});

test("runLevelFlags blocks a weekend run", () => {
  const flags = runLevelFlags("midday", etClock("2026-09-19T16:00:00Z"));
  const weekend = flags.find((flag) => flag.code === "NON_TRADING_DAY");
  assert.equal(weekend?.severity, "BLOCK");
});

test("runLevelFlags warns when a slot fires far from its target time", () => {
  // The midday slot targets 12:00 ET; this ran at 09:35 ET.
  const flags = runLevelFlags("midday", etClock("2026-09-16T13:35:00Z"));
  const drift = flags.find((flag) => flag.code === "SLOT_TIME_DRIFT");
  assert.equal(drift?.severity, "WARN");
  assert.match(drift?.message ?? "", /DST/, "the likely cause is named so it can be fixed");
});

test("runLevelFlags stays quiet when a slot fires near its target", () => {
  // 13:35 UTC is 09:35 ET, exactly the opening slot's target.
  assert.deepEqual(runLevelFlags("opening", etClock("2026-09-16T13:35:00Z")), []);
  // A few minutes of scheduler lag is not worth a warning.
  assert.deepEqual(runLevelFlags("opening", etClock("2026-09-16T13:42:00Z")), []);
});

test("priceDeltas compares against the prior run and sorts by absolute move", () => {
  const underlyings: UnderlyingQuote[] = [
    { symbol: "SPY", last: 660 },
    { symbol: "MU", last: 900 },
  ];
  const deltas = priceDeltas(underlyings, {
    runAt: "2026-09-16T13:35:00Z",
    slot: "opening",
    underlyingPrices: { SPY: 655, MU: 926 },
  });

  assert.equal(deltas[0]?.symbol, "MU", "the bigger move sorts first");
  assert.equal(deltas[0]?.changeRatio, -0.028078);
  assert.equal(deltas[1]?.symbol, "SPY");
  assert.equal(deltas[1]?.changeRatio, 0.007634);
});

test("priceDeltas returns nothing without a prior run, and skips symbols it cannot compare", () => {
  assert.deepEqual(priceDeltas([{ symbol: "SPY", last: 660 }], undefined), []);
  const partial = priceDeltas([{ symbol: "SPY", last: 660 }, { symbol: "NEW", last: 10 }], {
    runAt: "2026-09-16T13:35:00Z",
    slot: "opening",
    underlyingPrices: { SPY: 655 },
  });
  assert.deepEqual(partial.map((delta) => delta.symbol), ["SPY"]);
});

test("buildMarketReview computes deltas when handed a prior reference", () => {
  const review = buildMarketReview({
    runAt: "2026-09-16T16:00:00Z",
    slot: "midday",
    accountId: "5OI24720",
    sizing: SIZING,
    underlyings: [{ symbol: "SPY", last: 660 }],
    prior: { runAt: "2026-09-16T13:35:00Z", slot: "opening", underlyingPrices: { SPY: 655 } },
  });
  assert.equal(review.deltas.length, 1);
  assert.equal(review.deltas[0]?.priorPrice, 655);
});

test("buildMarketReview carries an incomplete report through untouched", () => {
  const review = buildMarketReview({
    runAt: "2026-09-16T13:00:00Z",
    slot: "pre-open",
    accountId: "5OI24720",
    sizing: SIZING,
    incomplete: { reason: "Public connector returned 503", details: ["get_quotes failed twice"] },
  });
  assert.equal(review.incomplete?.reason, "Public connector returned 503");
});

test("priorReferenceFrom captures the prices and symbols the next run needs", () => {
  const review = buildMarketReview({
    runAt: "2026-09-16T13:35:00Z",
    slot: "opening",
    accountId: "5OI24720",
    sizing: SIZING,
    underlyings: [{ symbol: "SPY", last: 655 }, { symbol: "MU", last: 926 }],
  });
  const reference = priorReferenceFrom(review);
  assert.deepEqual(reference.underlyingPrices, { SPY: 655, MU: 926 });
  assert.equal(reference.slot, "opening");
});
