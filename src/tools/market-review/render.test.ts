import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseContract } from "./analysis";
import { parseOsiSymbol } from "./osi";
import { rankRecommendations } from "./recommend";
import { renderMarketReview } from "./render";
import { buildMarketReview } from "./review";
import { CHECK_IN_SLOTS, type ChainLeg } from "./types";

const SIZING = { riskBudgetUsd: 500 } as const;

function spyLeg(): ChainLeg {
  const osiSymbol = "SPY260917C00660000";
  return {
    contract: parseOsiSymbol(osiSymbol),
    quote: { osiSymbol, last: 2.0, bid: 1.98, ask: 2.0, volume: 8000, openInterest: 20_000, timestamp: "2026-09-16T14:00:00Z" },
    greeks: { osiSymbol, delta: 0.45, gamma: 0.05, theta: -0.35, vega: 0.02, rho: 0.001, impliedVolatility: 0.18 },
  };
}

function fullReview(slot: (typeof CHECK_IN_SLOTS)[number]) {
  const analysis = analyseContract(spyLeg(), 655, "2026-09-16T14:01:00Z");
  const recommendations = rankRecommendations(
    [
      {
        thesis: {
          symbol: "SPY",
          direction: "BULLISH",
          conviction: "MEDIUM",
          mechanism: "Scheduled index rebalance flows into the close.",
          sources: ["Exchange rebalance notice 2026-09-15"],
        },
        analysis,
      },
    ],
    { sizing: SIZING },
  );

  return buildMarketReview({
    runAt: "2026-09-16T14:00:00Z",
    slot,
    accountId: "5OI24720",
    sizing: SIZING,
    vix: { symbol: "VIX", last: 17.71, previousClose: 17.2, dayChangeRatio: 0.0297 },
    underlyings: [{ symbol: "SPY", last: 655 }],
    candidates: [{ symbol: "SPY", sources: ["WATCHLIST"], note: "0DTE vehicle" }],
    catalysts: [{ symbol: "SPY", kind: "MACRO", date: "2026-09-16", tradingDaysAway: 0, detail: "FOMC 14:00 ET" }],
    contractAnalyses: [analysis],
    recommendations,
    notes: ["Checked Zacks real-time news and a web search for Fed commentary at 09:52 ET."],
  });
}

test("every slot renders a distinct title and purpose", () => {
  const titles = CHECK_IN_SLOTS.map((slot) => {
    const markdown = renderMarketReview(fullReview(slot));
    return markdown.split("\n").find((line) => line.startsWith("# ")) ?? "";
  });
  assert.equal(new Set(titles).size, CHECK_IN_SLOTS.length, "each slot needs its own heading");
  assert.match(titles[0] ?? "", /Pre-open plan/);
  assert.match(titles[3] ?? "", /Pre-close decision point/);
});

test("the sizing disclaimer appears whenever a size is printed", () => {
  for (const slot of CHECK_IN_SLOTS) {
    const markdown = renderMarketReview(fullReview(slot));
    assert.match(
      markdown,
      /not\*\* checked against this account's live buying power/,
      `the ${slot} report must carry the buying-power disclaimer`,
    );
  }
});

test("a recommendation prints its size, premium, and max loss as the whole premium", () => {
  const markdown = renderMarketReview(fullReview("opening"));
  assert.match(markdown, /Suggested size \| 2 contract\(s\)/);
  assert.match(markdown, /Premium per contract \| \$200\.00/);
  assert.match(markdown, /Total premium \| \$400\.00/);
  assert.match(markdown, /Maximum loss \| \$400\.00 \(the entire premium, for a long option\)/);
});

test("a recommendation prints its mechanism and its score breakdown", () => {
  const markdown = renderMarketReview(fullReview("midday"));
  assert.match(markdown, /\*\*Mechanism:\*\* Scheduled index rebalance flows into the close\./);
  assert.match(markdown, /built only from measurable mechanics, never from a prediction/);
  assert.match(markdown, /Exchange rebalance notice 2026-09-15/);
});

test("the contract section reports theta per contract and labels delta honestly", () => {
  const markdown = renderMarketReview(fullReview("pre-open"));
  // Per-share theta of -0.35 is -$35.00 per contract per day.
  assert.match(markdown, /-\$35\.00 per contract per day/);
  assert.match(markdown, /rough in-the-money proxy, \*\*not\*\* probability of profit/);
});

test("breakeven, 2x and worthless all appear with the move required", () => {
  const markdown = renderMarketReview(fullReview("pre-open"));
  assert.match(markdown, /Breakeven at expiration \| \$662\.00/);
  assert.match(markdown, /Doubles at \| \$664\.00/);
  assert.match(markdown, /Worthless at or beyond \| \$660\.00/);
});

test("VIX is presented as primary and chain IV as secondary", () => {
  const markdown = renderMarketReview(fullReview("opening"));
  assert.match(markdown, /\*\*VIX 17\.71\*\*/);
  assert.match(markdown, /primary volatility gauge/);
  assert.match(markdown, /secondary to VIX above/);
});

test("the pre-close report adds the minutes-remaining framing the other slots do not", () => {
  const preClose = renderMarketReview(fullReview("pre-close"));
  const midday = renderMarketReview(fullReview("midday"));
  assert.match(preClose, /whether the required move can happen in the minutes remaining/);
  assert.equal(/minutes remaining/.test(midday), false);
});

test("an incomplete run says so first and warns the reader off the rest", () => {
  const review = buildMarketReview({
    runAt: "2026-09-16T13:00:00Z",
    slot: "pre-open",
    accountId: "5OI24720",
    sizing: SIZING,
    incomplete: {
      reason: "The Public.com connector returned 503 on every attempt.",
      details: ["get_quotes failed 3x", "No chain pulled"],
    },
  });
  const markdown = renderMarketReview(review);

  const failureIndex = markdown.indexOf("This run did not complete");
  assert.ok(failureIndex > 0, "the failure section must be present");
  assert.ok(failureIndex < markdown.indexOf("## Session clock"), "it must come before the data sections");
  assert.match(markdown, /Do not read an absent section as an absence of risk/);
  assert.match(markdown, /complete: false/, "frontmatter must mark the run incomplete");
});

test("an empty catalyst list distinguishes 'none found' from 'none exist'", () => {
  const review = buildMarketReview({
    runAt: "2026-09-16T13:00:00Z",
    slot: "pre-open",
    accountId: "5OI24720",
    sizing: SIZING,
  });
  const markdown = renderMarketReview(review);
  assert.match(markdown, /absence of \*found\* events, not a guarantee of a quiet window/);
});

test("a report with no recommendations says so rather than printing an empty section", () => {
  const review = buildMarketReview({
    runAt: "2026-09-16T14:00:00Z",
    slot: "midday",
    accountId: "5OI24720",
    sizing: SIZING,
  });
  assert.match(renderMarketReview(review), /No candidate reached a stated thesis this run/);
});

test("every report repeats that it cannot place an order and that the account is shared", () => {
  const withPositions = buildMarketReview({
    runAt: "2026-09-16T13:00:00Z",
    slot: "pre-open",
    accountId: "5OI24720",
    sizing: SIZING,
    snapshot: {
      accountId: "5OI24720",
      accountType: "BROKERAGE",
      buyingPower: 2.2,
      cash: 2.2,
      totalAccountValue: 747.94,
      equity: [],
      openOrders: [],
      positions: [
        {
          symbol: "MU",
          name: "Micron",
          instrumentType: "EQUITY",
          quantity: 0.1086,
          openedAt: "2026-09-08T20:00:00Z",
          currentValue: 100.65,
          percentOfPortfolio: 0.1346,
          lastPrice: 926.78,
          totalCost: 105.21,
          unitCost: 968.78,
          unrealisedGain: -4.56,
          unrealisedGainRatio: -0.0434,
        },
      ],
    },
  });
  const markdown = renderMarketReview(withPositions);
  assert.match(markdown, /exposes no method that could place, modify, or cancel an order/);
  assert.match(markdown, /also traded by the existing Public\.com Agents/);
  assert.match(markdown, /\| MU \| EQUITY \| \$100\.65 \| 13\.5% \|/);
});

test("frontmatter carries the headline facts a later run can read without parsing prose", () => {
  const markdown = renderMarketReview(fullReview("opening"));
  assert.match(markdown, /^---\n/);
  assert.match(markdown, /slot: "opening"/);
  assert.match(markdown, /etTime: "10:00"/);
  assert.match(markdown, /riskBudgetUsd: 500/);
  assert.match(markdown, /recommendations: 1/);
});

test("duplicate flags collapse to one line each", () => {
  const analysis = analyseContract(spyLeg(), 655, "2026-09-16T14:01:00Z");
  const noisy = { ...analysis, flags: [...analysis.flags, ...analysis.flags, { code: "WIDE_SPREAD", severity: "WARN" as const, message: "same" }, { code: "WIDE_SPREAD", severity: "WARN" as const, message: "same" }] };
  const review = buildMarketReview({
    runAt: "2026-09-16T14:00:00Z",
    slot: "midday",
    accountId: "5OI24720",
    sizing: SIZING,
    contractAnalyses: [noisy],
  });
  const markdown = renderMarketReview(review);
  assert.equal((markdown.match(/\*\*WIDE_SPREAD\*\* — same/g) ?? []).length, 1);
});
