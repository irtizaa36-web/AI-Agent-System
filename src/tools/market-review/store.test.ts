import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendLogEntries,
  logEntriesFor,
  readLatestRunStamp,
  readLogEntries,
  readPriorReference,
  reviewFileName,
  writeMarketReview,
} from "./store";
import { buildMarketReview } from "./review";
import { rankRecommendations } from "./recommend";
import { analyseContract } from "./analysis";
import { parseOsiSymbol } from "./osi";
import type { ChainLeg } from "./types";

const SIZING = { riskBudgetUsd: 500 } as const;

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "market-review-test-"));
}

function spyAnalysis() {
  const osiSymbol = "SPY260917C00660000";
  const leg: ChainLeg = {
    contract: parseOsiSymbol(osiSymbol),
    quote: { osiSymbol, last: 2, bid: 1.98, ask: 2.0, timestamp: "2026-09-16T14:00:00Z" },
    greeks: { osiSymbol, delta: 0.45, gamma: 0.05, theta: -0.35, vega: 0.02, rho: 0.001, impliedVolatility: 0.18 },
  };
  return analyseContract(leg, 655, "2026-09-16T14:01:00Z");
}

function reviewWithRecommendation() {
  const analysis = spyAnalysis();
  return buildMarketReview({
    runAt: "2026-09-16T13:35:00Z",
    slot: "opening",
    accountId: "5OI24720",
    sizing: SIZING,
    vix: { symbol: "VIX", last: 17.71 },
    underlyings: [{ symbol: "SPY", last: 655 }],
    contractAnalyses: [analysis],
    recommendations: rankRecommendations(
      [
        {
          thesis: {
            symbol: "SPY",
            direction: "BULLISH",
            conviction: "MEDIUM",
            mechanism: "Scheduled index rebalance flows into the close.",
          },
          analysis,
        },
      ],
      { sizing: SIZING },
    ),
  });
}

test("reviewFileName names a file by ET date and slot, suffixing a repeat", () => {
  assert.equal(reviewFileName("2026-09-16", "pre-open"), "2026-09-16-pre-open.md");
  assert.equal(
    reviewFileName("2026-09-16", "pre-open", ["2026-09-16-pre-open.md"]),
    "2026-09-16-pre-open-2.md",
  );
  assert.equal(
    reviewFileName("2026-09-16", "pre-open", ["2026-09-16-pre-open.md", "2026-09-16-pre-open-2.md"]),
    "2026-09-16-pre-open-3.md",
  );
});

test("reviewFileName keeps the four slots in separate files on the same day", async () => {
  const dir = await scratchDir();
  const first = await writeMarketReview(reviewWithRecommendation(), dir);
  const preClose = buildMarketReview({
    runAt: "2026-09-16T19:30:00Z",
    slot: "pre-close",
    accountId: "5OI24720",
    sizing: SIZING,
  });
  const second = await writeMarketReview(preClose, dir);

  assert.match(first.path, /2026-09-16-opening\.md$/);
  assert.match(second.path, /2026-09-16-pre-close\.md$/);
});

test("writeMarketReview writes the rendered report to disk", async () => {
  const dir = await scratchDir();
  const written = await writeMarketReview(reviewWithRecommendation(), dir);
  const onDisk = await readFile(written.path, "utf-8");
  assert.equal(onDisk, written.markdown);
  assert.match(onDisk, /Opening-move confirmation/);
});

test("readLatestRunStamp reads the newest report's run stamp back out of frontmatter", async () => {
  const dir = await scratchDir();
  await writeMarketReview(reviewWithRecommendation(), dir);
  const stamp = await readLatestRunStamp(dir);
  assert.equal(stamp?.runAt, "2026-09-16T13:35:00Z");
  assert.equal(stamp?.slot, "opening");
});

test("readLatestRunStamp returns undefined for a directory with no reports", async () => {
  assert.equal(await readLatestRunStamp(await scratchDir()), undefined);
});

test("logEntriesFor turns each recommendation into a prediction row with its prices", () => {
  const entries = logEntriesFor(reviewWithRecommendation());
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry?.kind, "PREDICTION");
  if (entry?.kind !== "PREDICTION") return;

  assert.equal(entry.symbol, "SPY");
  assert.equal(entry.direction, "BULLISH");
  assert.equal(entry.suggestedContracts, 2);
  assert.equal(entry.theoreticalEntry, 200, "per-contract premium, not per-share");
  assert.equal(entry.osiSymbol, "SPY260917C00660000");
  assert.equal(entry.breakeven, 662);
  assert.deepEqual(entry.underlyingPrices, { SPY: 655 });
  assert.equal(entry.vix, 17.71);
});

test("logEntriesFor attaches the recommended contract, not another leg on the same underlying", () => {
  // Regression: a run that analysed both a SPY call and a SPY put, with the
  // recommendation on the put, logged the *call's* OSI symbol and breakeven
  // because the lookup matched on the underlying. Both legs share "SPY", so the
  // only safe key is the contract's own identity.
  const callLeg: ChainLeg = {
    contract: parseOsiSymbol("SPY260917C00754000"),
    quote: { osiSymbol: "SPY260917C00754000", last: 2.99, bid: 2.97, ask: 2.98, timestamp: "2026-09-16T19:29:00Z" },
    greeks: {
      osiSymbol: "SPY260917C00754000",
      delta: 0.5091,
      gamma: 0.0547,
      theta: -1.4949,
      vega: 0.1574,
      rho: 0.0104,
      impliedVolatility: 0.1848,
    },
  };
  const putLeg: ChainLeg = {
    contract: parseOsiSymbol("SPY260917P00754000"),
    quote: { osiSymbol: "SPY260917P00754000", last: 2.87, bid: 2.87, ask: 2.87, timestamp: "2026-09-16T19:29:00Z" },
    greeks: {
      osiSymbol: "SPY260917P00754000",
      delta: -0.491,
      gamma: 0.0542,
      theta: -1.4274,
      vega: 0.1574,
      rho: -0.0102,
      impliedVolatility: 0.1865,
    },
  };

  const callAnalysis = analyseContract(callLeg, 754.2367, "2026-09-16T19:30:00Z");
  const putAnalysis = analyseContract(putLeg, 754.2367, "2026-09-16T19:30:00Z");

  const review = buildMarketReview({
    runAt: "2026-09-16T19:30:00Z",
    slot: "pre-close",
    accountId: "5OI24720",
    sizing: SIZING,
    underlyings: [{ symbol: "SPY", last: 754.2367 }],
    // The call is listed first, so an underlying-keyed lookup would pick it.
    contractAnalyses: [callAnalysis, putAnalysis],
    recommendations: rankRecommendations(
      [
        {
          thesis: {
            symbol: "SPY",
            direction: "BEARISH",
            conviction: "LOW",
            mechanism: "Index closed lower with VIX up; the realised move went to the put side.",
          },
          analysis: putAnalysis,
        },
      ],
      { sizing: SIZING },
    ),
  });

  const [entry] = logEntriesFor(review);
  if (entry?.kind !== "PREDICTION") throw new Error("expected a prediction row");

  assert.equal(entry.osiSymbol, "SPY260917P00754000", "must log the put, not the call listed before it");
  assert.match(entry.contractLabel ?? "", /put/);
  // The put's breakeven is strike - premium = 751.13; the call's is 756.98.
  assert.equal(entry.breakeven, 751.13);
  assert.equal(entry.theoreticalEntry, 287);
});

test("logEntriesFor still logs one row when nothing was recommended, so a quiet run is distinguishable", () => {
  const quiet = buildMarketReview({
    runAt: "2026-09-16T16:00:00Z",
    slot: "midday",
    accountId: "5OI24720",
    sizing: SIZING,
    underlyings: [{ symbol: "SPY", last: 658 }],
  });
  const entries = logEntriesFor(quiet);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  if (entry?.kind !== "PREDICTION") throw new Error("expected a prediction row");
  assert.equal(entry.symbol, "—");
  assert.equal(entry.direction, "NONE");
  assert.deepEqual(entry.underlyingPrices, { SPY: 658 });
});

test("logEntriesFor records an incomplete run's reason instead of a thesis", () => {
  const failed = buildMarketReview({
    runAt: "2026-09-16T13:00:00Z",
    slot: "pre-open",
    accountId: "5OI24720",
    sizing: SIZING,
    incomplete: { reason: "Connector returned 503", details: [] },
  });
  const [entry] = logEntriesFor(failed);
  if (entry?.kind !== "PREDICTION") throw new Error("expected a prediction row");
  assert.equal(entry.blocked, true);
  assert.match(entry.mechanism, /did not complete: Connector returned 503/);
});

test("appendLogEntries appends without rewriting earlier rows", async () => {
  const dir = await scratchDir();
  const logPath = join(dir, "prediction-log.jsonl");

  await appendLogEntries(logEntriesFor(reviewWithRecommendation()), logPath);
  await appendLogEntries(
    [
      {
        kind: "OUTCOME",
        recordedAt: "2026-09-16T20:05:00Z",
        forRunAt: "2026-09-16T13:35:00Z",
        symbol: "SPY",
        asOf: "2026-09-16T20:00:00Z",
        referenceLabel: "16:00 ET close",
        optionMark: 3.1,
        theoreticalEntry: 2.0,
        theoreticalPlPerContract: 1.1,
      },
    ],
    logPath,
  );

  const entries = await readLogEntries(logPath);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.kind, "PREDICTION");
  assert.equal(entries[1]?.kind, "OUTCOME");

  const raw = await readFile(logPath, "utf-8");
  assert.equal(raw.trimEnd().split("\n").length, 2, "one JSON object per line");
});

test("appendLogEntries writes nothing for an empty list", async () => {
  const dir = await scratchDir();
  const logPath = join(dir, "prediction-log.jsonl");
  assert.equal(await appendLogEntries([], logPath), 0);
  assert.deepEqual(await readLogEntries(logPath), [], "no file was created");
});

test("readLogEntries returns an empty list when the log does not exist yet", async () => {
  assert.deepEqual(await readLogEntries(join(await scratchDir(), "absent.jsonl")), []);
});

test("readLogEntries reports a corrupt line rather than silently skipping it", async () => {
  const dir = await scratchDir();
  const logPath = join(dir, "prediction-log.jsonl");
  await writeFile(logPath, '{"kind":"PREDICTION"}\nnot json\n', "utf-8");
  await assert.rejects(() => readLogEntries(logPath), /line 2 is not valid JSON/);
});

test("readPriorReference finds the newest prediction row that carried prices", async () => {
  const dir = await scratchDir();
  const logPath = join(dir, "prediction-log.jsonl");

  await appendLogEntries(logEntriesFor(reviewWithRecommendation()), logPath);
  await appendLogEntries(
    logEntriesFor(
      buildMarketReview({
        runAt: "2026-09-16T16:00:00Z",
        slot: "midday",
        accountId: "5OI24720",
        sizing: SIZING,
        underlyings: [{ symbol: "SPY", last: 659 }],
      }),
    ),
    logPath,
  );

  const prior = await readPriorReference(logPath);
  assert.equal(prior?.slot, "midday", "the newest run wins");
  assert.deepEqual(prior?.underlyingPrices, { SPY: 659 });
});

test("readPriorReference returns undefined when the log holds no priced rows", async () => {
  assert.equal(await readPriorReference(join(await scratchDir(), "absent.jsonl")), undefined);
});
