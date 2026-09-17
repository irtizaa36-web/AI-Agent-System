import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gradeAllSignals,
  gradeExternalSignal,
  summariseBySource,
  validateExternalSignal,
  type ExternalSignal,
  type ExternalSignalOutcome,
} from "./external-signals";

function signal(overrides: Partial<ExternalSignal> = {}): ExternalSignal {
  return {
    sourceName: "SPY Day Trading",
    sourceUrl: "https://www.youtube.com/@SPYDayTrading",
    videoUrl: "https://www.youtube.com/watch?v=QfP9xNZTQxw",
    videoTitle: "RATE HIKE TRAP IS SET! (17 SEP) - SPY QQQ Options ES NQ Swing & Day Trading",
    recordedAt: "2026-09-17T12:00:00Z",
    forDate: "2026-09-17",
    symbol: "SPY",
    direction: "BEARISH",
    statedThesis: "Rate-hike rally is a trap; expects a reversal lower after the initial move up.",
    ...overrides,
  };
}

function outcome(overrides: Partial<ExternalSignalOutcome> = {}): ExternalSignalOutcome {
  return {
    videoUrl: "https://www.youtube.com/watch?v=QfP9xNZTQxw",
    symbol: "SPY",
    recordedAt: "2026-09-17T20:05:00Z",
    asOf: "2026-09-17T20:00:00Z",
    referenceLabel: "16:00 ET close",
    priceAtCall: 757.39,
    priceAtReference: 754.24,
    ...overrides,
  };
}

test("validateExternalSignal rejects a call with no record of what was actually claimed", () => {
  assert.throws(() => validateExternalSignal(signal({ statedThesis: "  " })), /no stated thesis/);
});

test("validateExternalSignal rejects a signal with no source or no identifiable video", () => {
  assert.throws(() => validateExternalSignal(signal({ sourceName: "" })), /sourceName/);
  assert.throws(() => validateExternalSignal(signal({ videoUrl: "" })), /videoUrl/);
});

test("validateExternalSignal accepts a well-formed signal", () => {
  assert.doesNotThrow(() => validateExternalSignal(signal()));
});

test("gradeExternalSignal returns UNGRADED with no outcome yet", () => {
  const graded = gradeExternalSignal(signal(), undefined);
  assert.equal(graded.grade, "UNGRADED");
  assert.match(graded.reason, /No outcome recorded/);
});

test("gradeExternalSignal scores a BEARISH call as a HIT when the price actually fell", () => {
  // The real SPY move: 757.39 -> 754.24 is -0.416%, against a BEARISH call.
  const graded = gradeExternalSignal(signal({ direction: "BEARISH" }), outcome());
  assert.equal(graded.grade, "HIT");
  assert.equal(graded.actualMoveRatio, -0.004159);
});

test("gradeExternalSignal scores the same move as a MISS for a BULLISH call", () => {
  const graded = gradeExternalSignal(signal({ direction: "BULLISH" }), outcome());
  assert.equal(graded.grade, "MISS");
});

test("gradeExternalSignal never grades a NEUTRAL call, regardless of the move", () => {
  const graded = gradeExternalSignal(signal({ direction: "NEUTRAL" }), outcome());
  assert.equal(graded.grade, "UNGRADED");
  assert.match(graded.reason, /NEUTRAL calls are recorded but never graded/);
});

test("gradeExternalSignal is UNGRADED without a priceAtCall to measure a move from", () => {
  const graded = gradeExternalSignal(signal(), outcome({ priceAtCall: undefined }));
  assert.equal(graded.grade, "UNGRADED");
  assert.match(graded.reason, /No priceAtCall/);
});

test("gradeExternalSignal refuses an outcome timestamped before the call was recorded", () => {
  assert.throws(
    () =>
      gradeExternalSignal(
        signal({ recordedAt: "2026-09-17T20:00:00Z" }),
        outcome({ asOf: "2026-09-17T12:00:00Z" }),
      ),
    /is not a prediction being checked/,
  );
});

test("gradeAllSignals pairs each signal with its own outcome by video and symbol", () => {
  const signals = [
    signal({ videoUrl: "https://youtube.com/a", symbol: "SPY", direction: "BEARISH" }),
    signal({ videoUrl: "https://youtube.com/a", symbol: "QQQ", direction: "BULLISH" }),
  ];
  const outcomes = [
    outcome({ videoUrl: "https://youtube.com/a", symbol: "SPY", priceAtCall: 757, priceAtReference: 754 }),
    outcome({ videoUrl: "https://youtube.com/a", symbol: "QQQ", priceAtCall: 600, priceAtReference: 605 }),
  ];
  const graded = gradeAllSignals(signals, outcomes);
  assert.equal(graded[0]?.grade, "HIT", "SPY fell as called");
  assert.equal(graded[1]?.grade, "HIT", "QQQ rose as called");
});

test("gradeAllSignals leaves a signal with no matching outcome UNGRADED, not mismatched to another symbol's move", () => {
  const graded = gradeAllSignals(
    [signal({ videoUrl: "https://youtube.com/a", symbol: "SPY" })],
    [outcome({ videoUrl: "https://youtube.com/a", symbol: "QQQ" })],
  );
  assert.equal(graded[0]?.grade, "UNGRADED");
});

test("summariseBySource computes a hit rate only from graded calls, never counting ungraded ones as misses", () => {
  const graded = gradeAllSignals(
    [
      signal({ videoUrl: "https://youtube.com/1", symbol: "SPY", direction: "BEARISH" }),
      signal({ videoUrl: "https://youtube.com/2", symbol: "SPY", direction: "BULLISH" }),
      signal({ videoUrl: "https://youtube.com/3", symbol: "SPY", direction: "NEUTRAL" }),
      signal({ videoUrl: "https://youtube.com/4", symbol: "SPY", direction: "BEARISH" }), // no outcome
    ],
    [
      outcome({ videoUrl: "https://youtube.com/1", priceAtCall: 757, priceAtReference: 754 }), // HIT
      outcome({ videoUrl: "https://youtube.com/2", priceAtCall: 757, priceAtReference: 754 }), // MISS
      outcome({ videoUrl: "https://youtube.com/3", priceAtCall: 757, priceAtReference: 754 }), // UNGRADED (neutral)
    ],
  );

  const [stats] = summariseBySource(graded);
  assert.equal(stats?.sourceName, "SPY Day Trading");
  assert.equal(stats?.totalCalls, 4);
  assert.equal(stats?.hits, 1);
  assert.equal(stats?.misses, 1);
  assert.equal(stats?.ungraded, 2, "the neutral call and the outcome-less call");
  assert.equal(stats?.hitRate, 0.5);
});

test("summariseBySource reports undefined hit rate rather than 0 when nothing is graded yet", () => {
  const graded = gradeAllSignals([signal({ direction: "NEUTRAL" })], []);
  const [stats] = summariseBySource(graded);
  assert.equal(stats?.hitRate, undefined, "an unrated source must not read as a 0% one");
});

test("summariseBySource keeps sources separate rather than pooling them into one rate", () => {
  const graded = gradeAllSignals(
    [
      signal({ sourceName: "Channel A", videoUrl: "https://youtube.com/a", direction: "BEARISH" }),
      signal({ sourceName: "Channel B", videoUrl: "https://youtube.com/b", direction: "BULLISH" }),
    ],
    [
      outcome({ videoUrl: "https://youtube.com/a", priceAtCall: 757, priceAtReference: 754 }),
      outcome({ videoUrl: "https://youtube.com/b", priceAtCall: 757, priceAtReference: 754 }),
    ],
  );
  const stats = summariseBySource(graded);
  assert.equal(stats.length, 2);
  assert.equal(stats.find((entry) => entry.sourceName === "Channel A")?.hitRate, 1, "A called it right");
  assert.equal(stats.find((entry) => entry.sourceName === "Channel B")?.hitRate, 0, "B called it wrong");
});
