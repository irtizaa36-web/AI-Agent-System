import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendExternalSignalEntries,
  readExternalSignalEntries,
  splitExternalSignalLog,
} from "./external-signals-store";
import type { ExternalSignal, ExternalSignalOutcome } from "./external-signals";

async function scratchLog(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "external-signals-test-"));
  return join(dir, "external-signals.jsonl");
}

const SIGNAL: ExternalSignal = {
  sourceName: "SPY Day Trading",
  sourceUrl: "https://www.youtube.com/@SPYDayTrading",
  videoUrl: "https://www.youtube.com/watch?v=QfP9xNZTQxw",
  videoTitle: "RATE HIKE TRAP IS SET! (17 SEP) - SPY QQQ Options ES NQ Swing & Day Trading",
  recordedAt: "2026-09-17T12:00:00Z",
  forDate: "2026-09-17",
  symbol: "SPY",
  direction: "BEARISH",
  statedThesis: "Rate-hike rally is a trap; expects a reversal lower after the initial move up.",
};

const OUTCOME: ExternalSignalOutcome = {
  videoUrl: "https://www.youtube.com/watch?v=QfP9xNZTQxw",
  symbol: "SPY",
  recordedAt: "2026-09-17T20:05:00Z",
  asOf: "2026-09-17T20:00:00Z",
  referenceLabel: "16:00 ET close",
  priceAtCall: 757.39,
  priceAtReference: 754.24,
};

test("appendExternalSignalEntries and readExternalSignalEntries round-trip both row kinds", async () => {
  const logPath = await scratchLog();
  await appendExternalSignalEntries([{ kind: "SIGNAL", ...SIGNAL }], logPath);
  await appendExternalSignalEntries([{ kind: "OUTCOME", ...OUTCOME }], logPath);

  const entries = await readExternalSignalEntries(logPath);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.kind, "SIGNAL");
  assert.equal(entries[1]?.kind, "OUTCOME");
});

test("appending never rewrites an earlier row", async () => {
  const logPath = await scratchLog();
  await appendExternalSignalEntries([{ kind: "SIGNAL", ...SIGNAL }], logPath);
  await appendExternalSignalEntries(
    [{ kind: "SIGNAL", ...SIGNAL, videoUrl: "https://www.youtube.com/watch?v=other" }],
    logPath,
  );
  const raw = await readFile(logPath, "utf-8");
  assert.equal(raw.trimEnd().split("\n").length, 2);
});

test("readExternalSignalEntries reads no rows from a file that does not exist yet", async () => {
  assert.deepEqual(await readExternalSignalEntries(join(await scratchLog())), []);
});

test("readExternalSignalEntries reports a corrupt line rather than silently dropping it", async () => {
  const logPath = await scratchLog();
  await appendExternalSignalEntries([{ kind: "SIGNAL", ...SIGNAL }], logPath);
  const { appendFile } = await import("node:fs/promises");
  await appendFile(logPath, "not json\n", "utf-8");
  await assert.rejects(() => readExternalSignalEntries(logPath), /line 2 is not valid JSON/);
});

test("appendExternalSignalEntries writes nothing for an empty list", async () => {
  const logPath = await scratchLog();
  assert.equal(await appendExternalSignalEntries([], logPath), 0);
  assert.deepEqual(await readExternalSignalEntries(logPath), []);
});

test("splitExternalSignalLog separates signals from outcomes and drops the discriminant", async () => {
  const logPath = await scratchLog();
  await appendExternalSignalEntries([{ kind: "SIGNAL", ...SIGNAL }, { kind: "OUTCOME", ...OUTCOME }], logPath);

  const { signals, outcomes } = splitExternalSignalLog(await readExternalSignalEntries(logPath));
  assert.equal(signals.length, 1);
  assert.equal(outcomes.length, 1);
  assert.equal(signals[0]?.symbol, "SPY");
  assert.equal(outcomes[0]?.priceAtReference, 754.24);
  assert.equal((signals[0] as { kind?: unknown }).kind, undefined, "the kind discriminant must not leak into the domain type");
});
