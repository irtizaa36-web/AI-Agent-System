import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyseContract,
  atmStrike,
  checkIvTermStructure,
  etClock,
  hasUsableIv,
  isWeekendEt,
  legQualityFlags,
  quoteFreshnessFlags,
  resolveEntryPrice,
  strikesNearSpot,
  worstSeverity,
} from "./analysis";
import { parseOsiSymbol } from "./osi";
import type { ChainLeg, ChainSnapshot } from "./types";

function leg(
  osiSymbol: string,
  quote: Partial<ChainLeg["quote"]> = {},
  greeks?: Partial<NonNullable<ChainLeg["greeks"]>>,
  midPrice?: number,
): ChainLeg {
  return {
    contract: parseOsiSymbol(osiSymbol),
    quote: { osiSymbol, last: 0, ...quote },
    ...(greeks === undefined
      ? {}
      : {
          greeks: {
            osiSymbol,
            delta: 0.5,
            gamma: 0.1,
            theta: -0.01,
            vega: 0.01,
            rho: 0.001,
            impliedVolatility: 0.5,
            ...greeks,
          },
        }),
    ...(midPrice === undefined ? {} : { midPrice }),
  };
}

test("etClock converts to ET wall clock and classifies the session", () => {
  // 2026-09-16 13:45 UTC is 09:45 ET during EDT — just after the open.
  const open = etClock("2026-09-16T13:45:00Z");
  assert.equal(open.etDate, "2026-09-16");
  assert.equal(open.etTime, "09:45");
  assert.equal(open.session, "OPEN");
  assert.equal(open.minutesSinceOpen, 15);

  const premarket = etClock("2026-09-16T13:00:00Z");
  assert.equal(premarket.etTime, "09:00");
  assert.equal(premarket.session, "PREMARKET");
  assert.equal(premarket.minutesSinceOpen, -30);

  const afterHours = etClock("2026-09-16T20:30:00Z");
  assert.equal(afterHours.etTime, "16:30");
  assert.equal(afterHours.session, "AFTER_HOURS");
});

test("etClock uses the IANA zone so the DST transition is handled, not approximated", () => {
  // Mid-January is EST (UTC-5): 14:35 UTC is 09:35 ET.
  assert.equal(etClock("2027-01-15T14:35:00Z").etTime, "09:35");
  // Mid-July is EDT (UTC-4): the same ET wall clock is an hour earlier in UTC.
  assert.equal(etClock("2026-07-15T13:35:00Z").etTime, "09:35");
});

test("etClock reports the ET calendar date, not the UTC one, after the UTC rollover", () => {
  // 01:00 UTC on the 17th is still 21:00 ET on the 16th.
  const clock = etClock("2026-09-17T01:00:00Z");
  assert.equal(clock.etDate, "2026-09-16");
  assert.equal(clock.etTime, "21:00");
});

test("isWeekendEt flags Saturday and Sunday in ET", () => {
  assert.equal(isWeekendEt(etClock("2026-09-19T14:00:00Z")), true, "Saturday");
  assert.equal(isWeekendEt(etClock("2026-09-20T14:00:00Z")), true, "Sunday");
  assert.equal(isWeekendEt(etClock("2026-09-18T14:00:00Z")), false, "Friday");
});

test("quoteFreshnessFlags blocks on a premarket quote", () => {
  const flags = quoteFreshnessFlags("2026-09-16T13:00:00Z", "2026-09-16T13:05:00Z");
  const premarket = flags.find((flag) => flag.code === "PREMARKET_QUOTE");
  assert.ok(premarket, "expected a premarket flag");
  assert.equal(premarket?.severity, "BLOCK");
  assert.match(premarket?.message ?? "", /09:00 ET/);
});

test("quoteFreshnessFlags stays quiet on a live in-session quote", () => {
  const flags = quoteFreshnessFlags("2026-09-16T14:00:00Z", "2026-09-16T14:02:00Z");
  assert.deepEqual(flags, []);
});

test("quoteFreshnessFlags warns on a stale quote and on a missing timestamp", () => {
  const stale = quoteFreshnessFlags("2026-09-16T14:00:00Z", "2026-09-16T18:00:00Z");
  assert.equal(stale.some((flag) => flag.code === "STALE_QUOTE"), true);

  const missing = quoteFreshnessFlags(undefined, "2026-09-16T18:00:00Z");
  assert.equal(missing[0]?.code, "NO_QUOTE_TIMESTAMP");
  assert.equal(missing[0]?.severity, "WARN");
});

test("resolveEntryPrice prefers the ask, because that is what a buyer pays", () => {
  const withAsk = resolveEntryPrice(leg("SPY260917C00660000", { bid: 1.0, ask: 1.2, last: 5 }));
  assert.deepEqual(withAsk, { price: 1.2, basis: "ASK" });
});

test("resolveEntryPrice falls back to last only when there is no tradeable ask", () => {
  const noQuotes = resolveEntryPrice(leg("SPY260917C00660000", { last: 0.42 }));
  assert.deepEqual(noQuotes, { price: 0.42, basis: "LAST" });
});

test("resolveEntryPrice honours an explicit override", () => {
  const given = resolveEntryPrice(leg("SPY260917C00660000", { bid: 1, ask: 2 }), 1.5);
  assert.deepEqual(given, { price: 1.5, basis: "GIVEN" });
});

test("legQualityFlags blocks a strike with no bid", () => {
  const flags = legQualityFlags(leg("IOVA261016C00015000", { bid: 0, ask: 0.25 }));
  const zeroBid = flags.find((flag) => flag.code === "ZERO_BID");
  assert.equal(zeroBid?.severity, "BLOCK");
});

test("legQualityFlags escalates a spread that eats the premium", () => {
  // The real IOVA $12.50 call: bid 0.10 / ask 0.30, a 100%-of-mid spread.
  const flags = legQualityFlags(leg("IOVA261016C00012500", { bid: 0.1, ask: 0.3, last: 0.2 }));
  const severe = flags.find((flag) => flag.code === "SEVERE_SPREAD");
  assert.equal(severe?.severity, "BLOCK");
  assert.match(severe?.message ?? "", /100\.0% of mid/);
});

test("legQualityFlags warns on a merely wide spread without blocking", () => {
  const flags = legQualityFlags(leg("SPY260917C00660000", { bid: 1.0, ask: 1.1 }));
  assert.equal(flags.some((flag) => flag.code === "WIDE_SPREAD"), true);
  assert.equal(flags.some((flag) => flag.code === "SEVERE_SPREAD"), false);
});

test("legQualityFlags says nothing about a tight, liquid spread", () => {
  const flags = legQualityFlags(
    leg("SPY260917C00660000", { bid: 2.0, ask: 2.02, volume: 5000, openInterest: 10_000 }),
  );
  assert.deepEqual(flags, []);
});

test("legQualityFlags names the deep-ITM IV=0 artifact rather than trusting it", () => {
  // Straight from a live chain: IOVA $5 call reported delta 1.0 with IV 0.0.
  const flags = legQualityFlags(
    leg("IOVA261016C00005000", { bid: 4.3, ask: 5.2 }, { delta: 1, impliedVolatility: 0 }),
  );
  assert.equal(flags.some((flag) => flag.code === "IV_ARTIFACT"), true);
});

test("legQualityFlags flags zero open interest and zero volume separately", () => {
  const flags = legQualityFlags(leg("IOVA261016P00015000", { bid: 4.7, ask: 6.7, volume: 0, openInterest: 0 }));
  assert.equal(flags.some((flag) => flag.code === "NO_OPEN_INTEREST"), true);
  assert.equal(flags.some((flag) => flag.code === "NO_VOLUME"), true);
});

test("legQualityFlags surfaces a vendor mid that genuinely disagrees with (bid+ask)/2", () => {
  const flags = legQualityFlags(leg("SPY260917C00660000", { bid: 1.0, ask: 2.0 }, undefined, 1.2));
  const disagreement = flags.find((flag) => flag.code === "MID_DISAGREEMENT");
  assert.equal(disagreement?.severity, "INFO");
});

test("legQualityFlags treats ordinary vendor rounding as agreement, not a disagreement", () => {
  // Real chain values: bid 1.80 / ask 2.65 computes to 2.225 while the vendor
  // reports 2.22. That half-cent is rounding, and flagging it on every row
  // would bury the cases where the two really diverge.
  const flags = legQualityFlags(leg("IOVA261016C00007500", { bid: 1.8, ask: 2.65 }, undefined, 2.22));
  assert.equal(flags.some((flag) => flag.code === "MID_DISAGREEMENT"), false);
});

test("hasUsableIv excludes both missing Greeks and the deep-ITM artifact", () => {
  assert.equal(hasUsableIv(leg("SPY260917C00660000", {}, { impliedVolatility: 0.4, delta: 0.5 })), true);
  assert.equal(hasUsableIv(leg("SPY260917C00660000", {})), false, "no greeks at all");
  assert.equal(
    hasUsableIv(leg("SPY260917C00660000", {}, { impliedVolatility: 0, delta: 1 })),
    false,
    "deep-ITM artifact",
  );
});

test("analyseContract computes call breakeven, 2x and worthless from expiration value", () => {
  const analysis = analyseContract(
    leg(
      "SPY260917C00660000",
      { bid: 1.95, ask: 2.05, last: 2.0, volume: 9000, openInterest: 20_000, timestamp: "2026-09-16T14:00:00Z" },
      { delta: 0.45, theta: -0.35, impliedVolatility: 0.18 },
    ),
    655,
    "2026-09-16T14:01:00Z",
  );

  // Entry is the ask: $2.05 per share, $205 per contract.
  assert.equal(analysis.entryBasis, "ASK");
  assert.equal(analysis.entryPrice, 2.05);
  assert.equal(analysis.entryPricePerContract, 205);

  // Breakeven = strike + premium = 662.05, which is 1.076% above a 655 spot.
  assert.equal(analysis.breakeven, 662.05);
  assert.equal(Math.round(analysis.breakevenMoveRatio * 1e6) / 1e6, 0.010763);

  // 2x at expiration = strike + 2 * premium = 664.10.
  assert.equal(analysis.priceFor2x, 664.1);
  // Worthless at expiration = at or below the strike.
  assert.equal(analysis.priceForWorthless, 660);
  assert.ok(analysis.moveRatioForWorthless > 0, "a 655 spot must still rise to reach a 660 strike");

  // Theta is per share in the source and per contract in the output: 100x.
  assert.equal(analysis.thetaPerContractPerDay, -35);
  // $35/day against a $205 premium is ~17% of the position per day.
  assert.equal(Math.round((analysis.thetaShareOfPremium ?? 0) * 10_000) / 10_000, 0.1707);
});

test("analyseContract mirrors the maths for a put", () => {
  const analysis = analyseContract(
    leg("SPY260917P00650000", { bid: 1.0, ask: 1.1, timestamp: "2026-09-16T14:00:00Z" }, { delta: -0.4 }),
    655,
    "2026-09-16T14:01:00Z",
  );
  // Put breakeven = strike − premium; 2x = strike − 2 * premium.
  assert.equal(analysis.breakeven, 648.9);
  assert.equal(analysis.priceFor2x, 647.8);
  assert.equal(analysis.priceForWorthless, 650);
  assert.ok(analysis.breakevenMoveRatio < 0, "a put needs the underlying to fall");
});

test("analyseContract drops an IV of zero rather than reporting it as a reading", () => {
  const analysis = analyseContract(
    leg("IOVA261016C00005000", { bid: 4.3, ask: 5.2 }, { delta: 1, impliedVolatility: 0 }),
    9.94,
    "2026-09-16T14:00:00Z",
  );
  assert.equal(analysis.impliedVolatility, undefined);
  assert.equal(analysis.flags.some((flag) => flag.code === "IV_ARTIFACT"), true);
});

test("analyseContract carries the premarket block through to its flags", () => {
  const analysis = analyseContract(
    leg("SPY260917C00660000", { bid: 2, ask: 2.1, timestamp: "2026-09-16T13:00:00Z" }),
    655,
    "2026-09-16T13:01:00Z",
  );
  assert.equal(worstSeverity(analysis.flags), "BLOCK");
});

function chain(expiration: string, rows: readonly { strike: number; callIv?: number; delta?: number }[]): ChainSnapshot {
  return {
    underlying: "SPY",
    expiration,
    rows: rows.map((row) => ({
      strike: row.strike,
      call: leg(
        `SPY${expiration.slice(2).replace(/-/g, "")}C${String(Math.round(row.strike * 1000)).padStart(8, "0")}`,
        { bid: 1, ask: 1.1 },
        row.callIv === undefined ? undefined : { impliedVolatility: row.callIv, delta: row.delta ?? 0.5 },
      ),
    })),
  };
}

test("checkIvTermStructure flags a same-strike IV gap beyond 2x", () => {
  const near = chain("2026-09-17", [{ strike: 655, callIv: 0.18 }, { strike: 660, callIv: 0.2 }]);
  const far = chain("2026-09-18", [{ strike: 655, callIv: 0.19 }, { strike: 660, callIv: 0.65 }]);

  const check = checkIvTermStructure(near, far, ["CALL"]);
  assert.equal(check.comparisons.length, 2);
  const anomalous = check.comparisons.filter((comparison) => comparison.anomalous);
  assert.equal(anomalous.length, 1);
  assert.equal(anomalous[0]?.strike, 660);
  assert.equal(check.flags[0]?.code, "IV_TERM_ANOMALY");
});

test("checkIvTermStructure stays quiet on a normal term structure", () => {
  const near = chain("2026-09-17", [{ strike: 655, callIv: 0.18 }]);
  const far = chain("2026-09-18", [{ strike: 655, callIv: 0.21 }]);
  const check = checkIvTermStructure(near, far, ["CALL"]);
  assert.deepEqual(check.flags, []);
  assert.equal(check.comparisons[0]?.anomalous, false);
});

test("checkIvTermStructure skips the IV=0 artifact instead of flagging every deep-ITM strike", () => {
  const near = chain("2026-09-17", [{ strike: 600, callIv: 0, delta: 1 }]);
  const far = chain("2026-09-18", [{ strike: 600, callIv: 0.2 }]);
  const check = checkIvTermStructure(near, far, ["CALL"]);
  assert.deepEqual(check.comparisons, [], "an artifact is not a comparison");
  assert.deepEqual(check.flags, []);
});

test("checkIvTermStructure ignores strikes that only one expiration lists", () => {
  const near = chain("2026-09-17", [{ strike: 655, callIv: 0.18 }, { strike: 999, callIv: 0.9 }]);
  const far = chain("2026-09-18", [{ strike: 655, callIv: 0.19 }]);
  assert.equal(checkIvTermStructure(near, far, ["CALL"]).comparisons.length, 1);
});

test("atmStrike picks the strike closest to spot", () => {
  const snapshot = chain("2026-09-17", [{ strike: 650 }, { strike: 655 }, { strike: 660 }]);
  assert.equal(atmStrike(snapshot, 656.2), 655);
  assert.equal(atmStrike(snapshot, 658), 660);
  assert.equal(atmStrike({ ...snapshot, rows: [] }, 656), undefined);
});

test("strikesNearSpot narrows the chain to a dollar window around spot", () => {
  const snapshot = chain("2026-09-17", [{ strike: 645 }, { strike: 650 }, { strike: 655 }, { strike: 665 }]);
  const narrowed = strikesNearSpot(snapshot, 653, 5);
  assert.deepEqual(narrowed.rows.map((row) => row.strike), [650, 655]);
});

test("worstSeverity ranks BLOCK above WARN above INFO", () => {
  assert.equal(worstSeverity([]), undefined);
  assert.equal(worstSeverity([{ code: "a", severity: "INFO", message: "" }]), "INFO");
  assert.equal(
    worstSeverity([
      { code: "a", severity: "INFO", message: "" },
      { code: "b", severity: "WARN", message: "" },
    ]),
    "WARN",
  );
  assert.equal(
    worstSeverity([
      { code: "a", severity: "WARN", message: "" },
      { code: "b", severity: "BLOCK", message: "" },
    ]),
    "BLOCK",
  );
});
