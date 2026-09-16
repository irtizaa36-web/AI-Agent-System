import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseContract } from "./analysis";
import { parseOsiSymbol } from "./osi";
import { SIZING_DISCLAIMER, evidenceCaveatsFor, rankRecommendations, suggestContracts } from "./recommend";
import type { ChainLeg, CatalystFlag } from "./types";

function analysis(
  osiSymbol: string,
  underlyingPrice: number,
  quote: Partial<ChainLeg["quote"]>,
  greeks?: Partial<NonNullable<ChainLeg["greeks"]>>,
) {
  const leg: ChainLeg = {
    contract: parseOsiSymbol(osiSymbol),
    quote: { osiSymbol, last: 0, timestamp: "2026-09-16T14:00:00Z", ...quote },
    ...(greeks === undefined
      ? {}
      : {
          greeks: {
            osiSymbol,
            delta: 0.45,
            gamma: 0.05,
            theta: -0.1,
            vega: 0.02,
            rho: 0.001,
            impliedVolatility: 0.2,
            ...greeks,
          },
        }),
  };
  return analyseContract(leg, underlyingPrice, "2026-09-16T14:01:00Z");
}

test("suggestContracts floors against the risk budget, never rounding up past it", () => {
  assert.equal(suggestContracts(205, { riskBudgetUsd: 500 }), 2, "2 x 205 fits in 500, 3 does not");
  assert.equal(suggestContracts(205, { riskBudgetUsd: 205 }), 1);
  assert.equal(suggestContracts(205, { riskBudgetUsd: 204 }), 0, "cannot afford one without exceeding the budget");
});

test("suggestContracts honours a hard contract cap", () => {
  assert.equal(suggestContracts(10, { riskBudgetUsd: 1000, maxContracts: 5 }), 5);
});

test("suggestContracts refuses to size on nonsense inputs", () => {
  assert.equal(suggestContracts(0, { riskBudgetUsd: 500 }), 0);
  assert.equal(suggestContracts(-5, { riskBudgetUsd: 500 }), 0);
  assert.equal(suggestContracts(100, { riskBudgetUsd: 0 }), 0);
});

test("rankRecommendations refuses a thesis with no stated mechanism", () => {
  assert.throws(
    () =>
      rankRecommendations(
        [{ thesis: { symbol: "SPY", direction: "BULLISH", conviction: "HIGH", mechanism: "   " } }],
        { sizing: { riskBudgetUsd: 500 } },
      ),
    /no stated mechanism/,
  );
});

test("rankRecommendations sizes from the risk budget and reports max loss as the whole premium", () => {
  const [recommendation] = rankRecommendations(
    [
      {
        thesis: {
          symbol: "SPY",
          direction: "BULLISH",
          conviction: "MEDIUM",
          mechanism: "Index rebalance flows into the close, per the scheduled rebalance notice.",
          sources: ["Exchange rebalance notice 2026-09-15"],
        },
        analysis: analysis(
          "SPY260917C00660000",
          655,
          { bid: 1.98, ask: 2.0, volume: 8000, openInterest: 20_000 },
          { theta: -0.1 },
        ),
      },
    ],
    { sizing: { riskBudgetUsd: 500 } },
  );

  assert.equal(recommendation?.rank, 1);
  assert.equal(recommendation?.premiumPerContract, 200);
  assert.equal(recommendation?.contracts, 2);
  assert.equal(recommendation?.totalPremium, 400);
  assert.equal(recommendation?.maxLossUsd, 400, "for a long option, max loss is the entire premium");
  assert.equal(recommendation?.blocked, false);
  assert.deepEqual(recommendation?.sources, ["Exchange rebalance notice 2026-09-15"]);
});

test("rankRecommendations marks a contract with a blocking data problem as blocked", () => {
  const [recommendation] = rankRecommendations(
    [
      {
        thesis: {
          symbol: "IOVA",
          direction: "BULLISH",
          conviction: "LOW",
          mechanism: "Phase 2 readout expected this quarter per the company's own guidance.",
        },
        // Real values: bid 0.00 against a 0.25 ask — untradeable.
        analysis: analysis("IOVA261016C00015000", 9.94, { bid: 0, ask: 0.25 }),
      },
    ],
    { sizing: { riskBudgetUsd: 500 } },
  );

  assert.equal(recommendation?.blocked, true);
  assert.ok(
    recommendation?.scoreComponents.some((component) => component.label === "Blocking data problem"),
    "a blocking flag must be visible in the score breakdown",
  );
});

test("rankRecommendations ranks the cleaner contract above the one fighting its own mechanics", () => {
  const ranked = rankRecommendations(
    [
      {
        thesis: {
          symbol: "IOVA",
          direction: "BULLISH",
          conviction: "HIGH",
          mechanism: "Readout catalyst; high conviction from the operator.",
        },
        // 100%-of-mid spread, real IOVA values.
        analysis: analysis("IOVA261016C00012500", 9.94, { bid: 0.1, ask: 0.3 }, { theta: -0.01 }),
      },
      {
        thesis: {
          symbol: "SPY",
          direction: "BULLISH",
          conviction: "LOW",
          mechanism: "Rebalance flow into the close.",
        },
        analysis: analysis("SPY260917C00656000", 655, { bid: 1.98, ask: 2.0 }, { theta: -0.05 }),
      },
    ],
    { sizing: { riskBudgetUsd: 1000 } },
  );

  assert.equal(ranked[0]?.symbol, "SPY", "HIGH conviction must not outrank better mechanics");
  assert.equal(ranked[1]?.symbol, "IOVA");
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
});

test("rankRecommendations does not let conviction move the score", () => {
  const build = (conviction: "LOW" | "HIGH") =>
    rankRecommendations(
      [
        {
          thesis: { symbol: "SPY", direction: "BULLISH", conviction, mechanism: "Same mechanism both times." },
          analysis: analysis("SPY260917C00656000", 655, { bid: 1.98, ask: 2.0 }, { theta: -0.05 }),
        },
      ],
      { sizing: { riskBudgetUsd: 1000 } },
    )[0];

  assert.equal(build("LOW")?.score, build("HIGH")?.score);
});

test("rankRecommendations penalises an earnings window rather than rewarding it", () => {
  const catalysts: CatalystFlag[] = [
    { symbol: "MU", kind: "EARNINGS", date: "2026-09-18", tradingDaysAway: 2, detail: "Q4 earnings" },
  ];
  const withEarnings = rankRecommendations(
    [
      {
        thesis: { symbol: "MU", direction: "BULLISH", conviction: "MEDIUM", mechanism: "HBM demand commentary." },
        analysis: analysis("MU261016C00950000", 926, { bid: 20, ask: 20.5 }, { theta: -0.5 }),
        catalysts,
      },
    ],
    { sizing: { riskBudgetUsd: 5000 } },
  )[0];

  const without = rankRecommendations(
    [
      {
        thesis: { symbol: "MU", direction: "BULLISH", conviction: "MEDIUM", mechanism: "HBM demand commentary." },
        analysis: analysis("MU261016C00950000", 926, { bid: 20, ask: 20.5 }, { theta: -0.5 }),
      },
    ],
    { sizing: { riskBudgetUsd: 5000 } },
  )[0];

  assert.ok((withEarnings?.score ?? 0) < (without?.score ?? 0), "earnings proximity must cost score, not add it");
  assert.ok(
    withEarnings?.evidenceCaveats.some((caveat) => caveat.includes("de Silva/So/Smith")),
    "the earnings caveat must cite its source",
  );
});

test("evidenceCaveatsFor attaches the cost finding to a wide spread", () => {
  const caveats = evidenceCaveatsFor(analysis("IOVA261016C00012500", 9.94, { bid: 0.1, ask: 0.3 }), []);
  assert.ok(caveats.some((caveat) => caveat.includes("60% of 0DTE retail")));
});

test("evidenceCaveatsFor always explains what delta is not", () => {
  const caveats = evidenceCaveatsFor(
    analysis("SPY260917C00660000", 655, { bid: 2, ask: 2.05 }, { delta: 0.45 }),
    [],
  );
  assert.ok(caveats.some((caveat) => caveat.includes("not the")), "delta must never be presented as P(profit)");
});

test("evidenceCaveatsFor flags heavy theta with the number attached", () => {
  // $35/day of decay against a $205 premium is ~17% per day.
  const caveats = evidenceCaveatsFor(
    analysis("SPY260917C00660000", 655, { bid: 2.0, ask: 2.05 }, { theta: -0.35 }),
    [],
  );
  assert.ok(caveats.some((caveat) => /17\.1% of the premium per day/.test(caveat)));
});

test("evidenceCaveatsFor says nothing about contracts it was given no analysis for", () => {
  assert.deepEqual(evidenceCaveatsFor(undefined, []), []);
});

test("the sizing disclaimer names the buying-power gap explicitly", () => {
  assert.match(SIZING_DISCLAIMER, /not\*\* checked against this account's live buying power/);
  assert.match(SIZING_DISCLAIMER, /Nothing here is an order/);
});
