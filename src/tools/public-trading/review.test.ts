import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicTradingClient } from "./client";
import { parseWatermark, renderReview } from "./render";
import { buildReview, runReview } from "./review";
import { readLatestWatermark, reviewFileName, writeReview } from "./review-store";
import type { PortfolioSnapshot, Transaction } from "./types";

const SNAPSHOT: PortfolioSnapshot = {
  accountId: "5OI24720",
  accountType: "BROKERAGE",
  buyingPower: 14.91,
  cash: 146.6,
  totalAccountValue: 367.1,
  equity: [{ type: "CRYPTO", value: 187.8, percentOfPortfolio: 0.5116 }],
  positions: [
    {
      symbol: "AVAX",
      name: "Avalanche",
      instrumentType: "CRYPTO",
      quantity: 10.94,
      openedAt: "2026-09-07T02:30:34Z",
      currentValue: 87.9,
      percentOfPortfolio: 0.2394,
      lastPrice: 8.03,
      totalCost: 86.33,
      unitCost: 7.89,
      unrealisedGain: 1.6,
      unrealisedGainRatio: 0.0185,
    },
  ],
  openOrders: [
    {
      orderId: "o1",
      symbol: "ARIS",
      instrumentType: "EQUITY",
      side: "BUY",
      orderType: "LIMIT",
      status: "NEW",
      createdAt: "2026-09-09T02:56:14Z",
      notionalValue: 40,
      filledQuantity: 0,
    },
  ],
};

const TRANSACTIONS: readonly Transaction[] = [
  {
    id: "b1",
    timestamp: "2026-09-05T00:00:00Z",
    type: "TRADE",
    subType: "TRADE",
    symbol: "BTC",
    securityType: "CRYPTO",
    side: "BUY",
    description: "BUY BTC",
    netAmount: -40.24,
    principalAmount: -40,
    quantity: 1,
    fees: 0,
  },
  {
    id: "s1",
    timestamp: "2026-09-08T00:30:00Z",
    type: "TRADE",
    subType: "TRADE",
    symbol: "BTC",
    securityType: "CRYPTO",
    side: "SELL",
    description: "SELL BTC",
    netAmount: 39.58,
    principalAmount: 39.8,
    quantity: 1,
    fees: 0,
  },
];

function baseInput() {
  return {
    runAt: "2026-09-09T12:00:00.000Z",
    accountId: "5OI24720",
    snapshot: SNAPSHOT,
    transactions: TRANSACTIONS,
    drafts: { drafts: [], rejected: [], suppressedReason: "No validated signal is registered." },
  };
}

test("buildReview sets the watermark to the latest transaction so the next run can resume", () => {
  const review = buildReview(baseInput());
  assert.equal(review.watermark, "2026-09-08T00:30:00Z");
});

test("buildReview counts every round trip on a first run with no previous watermark", () => {
  const review = buildReview(baseInput());
  assert.equal(review.closedSinceLastRunSummary.count, 1);
  assert.equal(review.previousWatermark, undefined);
});

test("buildReview counts only trips closed after the previous watermark", () => {
  const review = buildReview({ ...baseInput(), previousWatermark: "2026-09-08T12:00:00Z" });
  assert.equal(review.closedSinceLastRunSummary.count, 0);
  // The window summary still sees it, so all-time context is not lost.
  assert.equal(review.windowSummary.count, 1);
});

test("buildReview measures realised cost drag against the briefing's 0.75% baseline", () => {
  const review = buildReview(baseInput());
  assert.equal(review.costDrag.baseline, 0.0075);
  // $0.24 in + $0.22 out on $40 of principal = 1.15%, above the baseline.
  assert.ok(review.costDrag.realisedRoundTrip > 0.0075);
  assert.ok(review.costDrag.deltaVsBaseline > 0);
  assert.ok(review.costDrag.note.includes("revised upward"));
});

test("buildReview says the baseline stands when there is nothing to measure", () => {
  const review = buildReview({ ...baseInput(), transactions: [] });
  assert.equal(review.costDrag.sampleSize, 0);
  assert.ok(review.costDrag.note.includes("stands unrevised"));
});

test("buildReview flags the infeasible open buy order", () => {
  const review = buildReview(baseInput());
  assert.equal(review.orderFeasibility.infeasible, true);
  assert.equal(review.orderFeasibility.shortfall, 25.09);
});

test("renderReview writes frontmatter that parseWatermark can read back", () => {
  const markdown = renderReview(buildReview(baseInput()));
  assert.ok(markdown.startsWith("---\n"));
  assert.equal(parseWatermark(markdown), "2026-09-08T00:30:00Z");
});

test("renderReview includes all five required sections plus order feasibility", () => {
  const markdown = renderReview(buildReview(baseInput()));
  for (const heading of [
    "## 1. Portfolio snapshot",
    "## 2. Closed-trade P/L",
    "## 3. Cost drag",
    "## 4. Concentration",
    "## 5. Open-order feasibility",
    "## 6. Drafted trades",
  ]) {
    assert.ok(markdown.includes(heading), `missing ${heading}`);
  }
});

test("renderReview leaves a blank line before every heading and around tables", () => {
  const markdown = renderReview(buildReview(baseInput()));
  const lines = markdown.split("\n");

  lines.forEach((line, index) => {
    if (!line.startsWith("#") || index === 0) return;
    assert.equal(lines[index - 1], "", `heading "${line}" is not preceded by a blank line`);
  });
  // A table must not be glued to the paragraph above it, or it renders as text.
  lines.forEach((line, index) => {
    if (!line.startsWith("| Metric |") && !line.startsWith("| Symbol |")) return;
    assert.equal(lines[index - 1], "", `table at line ${index} is not preceded by a blank line`);
  });
  assert.ok(!markdown.includes("\n\n\n"), "no run of blank lines should survive");
});

test("renderReview states plainly that no trades were drafted and why", () => {
  const markdown = renderReview(buildReview(baseInput()));
  assert.ok(markdown.includes("**No trades drafted.**"));
  assert.ok(markdown.includes("No validated signal is registered."));
});

test("renderReview records the separation from the existing Public.com Agent", () => {
  const markdown = renderReview(buildReview(baseInput()));
  assert.ok(markdown.includes("reads and drafts only"));
  assert.ok(markdown.includes("PROJECT-REGISTRY.md` §8"));
});

test("parseWatermark returns undefined for a file without frontmatter", () => {
  assert.equal(parseWatermark("# Just a heading\n"), undefined);
  assert.equal(parseWatermark("---\nrunAt: \"x\"\n---\n"), undefined);
});

test("reviewFileName names by date and suffixes a repeat run within the same day", () => {
  assert.equal(reviewFileName("2026-09-09T12:00:00Z"), "2026-09-09.md");
  assert.equal(reviewFileName("2026-09-09T12:00:00Z", ["2026-09-09.md"]), "2026-09-09-2.md");
  assert.equal(reviewFileName("2026-09-09T12:00:00Z", ["2026-09-09.md", "2026-09-09-2.md"]), "2026-09-09-3.md");
});

test("writeReview then readLatestWatermark round-trips continuity through the files themselves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "public-trading-"));

  assert.equal(await readLatestWatermark(dir), undefined);

  const written = await writeReview(buildReview(baseInput()), dir);
  assert.ok(written.path.endsWith("2026-09-09.md"));
  assert.ok((await readFile(written.path, "utf-8")).includes("# Public.com monitoring review"));
  assert.equal(await readLatestWatermark(dir), "2026-09-08T00:30:00Z");
});

test("readLatestWatermark reads the newest review and skips files without a watermark", async () => {
  const dir = await mkdtemp(join(tmpdir(), "public-trading-"));
  await writeFile(join(dir, "2026-09-01.md"), '---\nwatermark: "2026-09-01T00:00:00Z"\n---\n', "utf-8");
  await writeFile(join(dir, "2026-09-02.md"), "---\nrunAt: \"2026-09-02\"\n---\n", "utf-8");
  await writeFile(join(dir, "notes.md"), "not a review", "utf-8");

  assert.equal(await readLatestWatermark(dir), "2026-09-01T00:00:00Z");
});

test("readLatestWatermark returns undefined when the directory does not exist yet", async () => {
  assert.equal(await readLatestWatermark(join(tmpdir(), "definitely-not-created-yet-public-trading")), undefined);
});

test("runReview pulls portfolio and history, and drafts nothing with an empty registry", async () => {
  const calls: string[] = [];
  const client: PublicTradingClient = {
    async getPortfolio() {
      calls.push("getPortfolio");
      return SNAPSHOT;
    },
    async getHistory() {
      calls.push("getHistory");
      return TRANSACTIONS;
    },
    async getQuotes() {
      calls.push("getQuotes");
      return [];
    },
    async getPriceHistory() {
      calls.push("getPriceHistory");
      return [];
    },
    async preflightOrder() {
      calls.push("preflightOrder");
      throw new Error("should not be reached with an empty signal registry");
    },
  };

  const review = await runReview({ accountId: "5OI24720", client, runAt: "2026-09-09T12:00:00.000Z" });

  assert.deepEqual(calls, ["getPortfolio", "getHistory"]);
  // Price history is deliberately never pulled into context by the review path.
  assert.ok(!calls.includes("getPriceHistory"));
  assert.equal(review.drafts.drafts.length, 0);
  assert.ok(review.drafts.suppressedReason !== undefined);
  assert.equal(review.historyWindow.start, "2026-08-10T12:00:00.000Z");
});
