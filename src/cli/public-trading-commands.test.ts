import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPublicTradingCommand } from "./public-trading-commands";
import type { CliDeps } from "./index";

function deps(): CliDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
  } as unknown as CliDeps & { out: string[]; err: string[] };
}

const PORTFOLIO = {
  accountId: "5OI24720",
  accountType: "BROKERAGE",
  buyingPower: { buyingPower: "14.91" },
  equity: [{ type: "CRYPTO", value: "187.80", percentageOfPortfolio: "51.16" }],
  positions: [
    {
      instrument: { symbol: "AVAX", name: "Avalanche", type: "CRYPTO" },
      quantity: "10.94",
      openedAt: "2026-09-07T02:30:34Z",
      currentValue: "87.90",
      percentOfPortfolio: "23.94",
      lastPrice: { lastPrice: "8.03" },
      costBasis: { totalCost: "86.33", unitCost: "7.89", gainValue: "1.60" },
    },
  ],
  orders: [
    {
      orderId: "o1",
      instrument: { symbol: "ARIS", type: "EQUITY" },
      createdAt: "2026-09-09T02:56:14Z",
      type: "LIMIT",
      side: "BUY",
      status: "NEW",
      notionalValue: "40.00",
      filledQuantity: "0",
    },
  ],
  cash: "146.60",
  totalAccountValue: "367.10",
};

const HISTORY = {
  transactions: [
    {
      id: "b1",
      timestamp: "2026-09-05T00:00:00Z",
      type: "TRADE",
      subType: "TRADE",
      symbol: "BTC",
      securityType: "CRYPTO",
      side: "BUY",
      description: "BUY BTC",
      netAmount: "-40.24",
      principalAmount: "-40.00",
      quantity: "1",
      fees: "0.00",
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
      netAmount: "39.58",
      principalAmount: "39.80",
      quantity: "1",
      fees: "0.00",
    },
  ],
};

async function inputFile(payload: unknown): Promise<{ path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pt-cli-"));
  const path = join(dir, "input.json");
  await writeFile(path, JSON.stringify(payload), "utf-8");
  return { path, dir };
}

test("public-trading review writes a review file from raw MCP responses", async () => {
  const { path, dir } = await inputFile({ accountId: "5OI24720", portfolio: PORTFOLIO, history: HISTORY });
  const d = deps();

  const code = await runPublicTradingCommand(
    ["review", "--input", path, "--dir", dir, "--run-at", "2026-09-09T12:00:00.000Z"],
    d,
  );

  assert.equal(code, 0);
  const markdown = await readFile(join(dir, "2026-09-09.md"), "utf-8");
  assert.ok(markdown.includes("# Public.com monitoring review — 2026-09-09"));
  assert.ok(markdown.includes("$367.10"));
  assert.ok(d.out.some((line) => line.startsWith("Wrote ")));
});

test("public-trading review accepts the connector's double-encoded envelope", async () => {
  const { path, dir } = await inputFile({
    portfolio: { result: JSON.stringify(PORTFOLIO) },
    history: { result: JSON.stringify(HISTORY) },
  });

  assert.equal(await runPublicTradingCommand(["review", "--input", path, "--dir", dir], deps()), 0);
});

test("public-trading review accepts history as a bare transactions array", async () => {
  const { path, dir } = await inputFile({ portfolio: PORTFOLIO, history: HISTORY.transactions });
  const d = deps();

  assert.equal(
    await runPublicTradingCommand(["review", "--input", path, "--dir", dir, "--run-at", "2026-09-09T12:00:00Z"], d),
    0,
  );
  assert.ok(d.out.some((line) => line.includes("1 round trip(s) closed")));
});

test("public-trading review carries the watermark forward between runs", async () => {
  const { path, dir } = await inputFile({ portfolio: PORTFOLIO, history: HISTORY });

  const first = deps();
  await runPublicTradingCommand(["review", "--input", path, "--dir", dir, "--run-at", "2026-09-09T12:00:00Z"], first);
  assert.ok(first.out.some((line) => line.includes("1 round trip(s) closed")));

  // Same history on a second run: the trip is already accounted for, so it is
  // not double-counted into "since last run".
  const second = deps();
  await runPublicTradingCommand(["review", "--input", path, "--dir", dir, "--run-at", "2026-09-10T12:00:00Z"], second);
  assert.ok(second.out.some((line) => line.includes("0 round trip(s) closed")));
});

test("public-trading review reports the concentration and order-feasibility flags", async () => {
  const { path, dir } = await inputFile({ portfolio: PORTFOLIO, history: HISTORY });
  const d = deps();

  await runPublicTradingCommand(["review", "--input", path, "--dir", dir], d);

  assert.ok(d.out.some((line) => line.includes("AVAX") && line.includes("⚠️")));
  assert.ok(d.out.some((line) => line.includes("cannot all fill")));
});

test("public-trading review always states that nothing was drafted", async () => {
  const { path, dir } = await inputFile({ portfolio: PORTFOLIO, history: HISTORY });
  const d = deps();

  await runPublicTradingCommand(["review", "--input", path, "--dir", dir], d);

  assert.ok(d.out.some((line) => line.includes("No trades drafted")));
  const markdown = await readFile(join(dir, `${new Date().toISOString().slice(0, 10)}.md`), "utf-8");
  assert.ok(markdown.includes("**No trades drafted.**"));
});

test("public-trading rejects an unknown subcommand and a missing --input", async () => {
  const bad = deps();
  assert.equal(await runPublicTradingCommand(["place"], bad), 1);
  assert.ok(bad.err[0]!.includes("Usage:"));

  const missing = deps();
  assert.equal(await runPublicTradingCommand(["review"], missing), 1);
  assert.ok(missing.err[0]!.includes("--input is required"));
});

test("public-trading review reports a readable error for bad input rather than throwing", async () => {
  const noFile = deps();
  assert.equal(await runPublicTradingCommand(["review", "--input", "/nope/missing.json"], noFile), 1);
  assert.ok(noFile.err[0]!.includes("Could not read --input"));

  const { path, dir } = await inputFile({ history: HISTORY });
  const noPortfolio = deps();
  assert.equal(await runPublicTradingCommand(["review", "--input", path, "--dir", dir], noPortfolio), 1);
  assert.ok(noPortfolio.err[0]!.includes('missing "portfolio"'));

  const { path: badPath, dir: badDir } = await inputFile({ portfolio: { accountId: "x" } });
  const malformed = deps();
  assert.equal(await runPublicTradingCommand(["review", "--input", badPath, "--dir", badDir], malformed), 1);
  assert.ok(malformed.err[0]!.includes("Could not build the review"));
});
