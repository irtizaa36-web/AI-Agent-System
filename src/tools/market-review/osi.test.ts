import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOsiSymbol, describeContract, isOsiSymbol, osiRoot, parseOsiSymbol } from "./osi";

test("parseOsiSymbol reads the real contract this account holds", () => {
  const contract = parseOsiSymbol("IOVA261016C00012500");
  assert.equal(contract.underlying, "IOVA");
  assert.equal(contract.side, "CALL");
  assert.equal(contract.strike, 12.5);
  assert.equal(contract.expiration, "2026-10-16");
});

test("parseOsiSymbol handles roots of different lengths, anchoring on the right", () => {
  assert.equal(parseOsiSymbol("SPY260916P00660000").underlying, "SPY");
  assert.equal(parseOsiSymbol("SPY260916P00660000").strike, 660);
  assert.equal(parseOsiSymbol("GOOGL270115C00350000").underlying, "GOOGL");
  assert.equal(parseOsiSymbol("GOOGL270115C00350000").strike, 350);
});

test("parseOsiSymbol reads puts and sub-dollar strikes", () => {
  const penny = parseOsiSymbol("ABCD261016P00000500");
  assert.equal(penny.side, "PUT");
  assert.equal(penny.strike, 0.5);
});

test("parseOsiSymbol throws rather than guessing at a non-OSI string", () => {
  assert.throws(() => parseOsiSymbol("SPY"), /Not an OSI option symbol/);
  assert.throws(() => parseOsiSymbol("IOVA261016X00012500"), /Not an OSI option symbol/);
});

test("buildOsiSymbol round-trips through parseOsiSymbol", () => {
  const built = buildOsiSymbol("SPY", "2026-09-17", "CALL", 660);
  assert.equal(built, "SPY260917C00660000");
  const parsed = parseOsiSymbol(built);
  assert.equal(parsed.strike, 660);
  assert.equal(parsed.expiration, "2026-09-17");
  assert.equal(parsed.side, "CALL");
});

test("buildOsiSymbol rounds the strike field instead of truncating a float artifact", () => {
  // 0.07 * 1000 is 70.00000000000001 in binary float; truncation would still
  // land on 70 here, but 8.29 * 1000 is 8289.999999999998, which truncates to
  // the wrong strike. Rounding is what makes both correct.
  assert.equal(buildOsiSymbol("ABCD", "2026-10-16", "PUT", 8.29), "ABCD261016P00008290");
  assert.equal(parseOsiSymbol(buildOsiSymbol("ABCD", "2026-10-16", "PUT", 8.29)).strike, 8.29);
});

test("buildOsiSymbol rejects inputs it cannot encode faithfully", () => {
  assert.throws(() => buildOsiSymbol("SPY", "09/17/2026", "CALL", 660), /YYYY-MM-DD/);
  assert.throws(() => buildOsiSymbol("SPY", "2026-09-17", "CALL", 0), /positive number/);
  assert.throws(() => buildOsiSymbol("TOOLONGROOT", "2026-09-17", "CALL", 10), /root symbol/);
});

test("isOsiSymbol separates contracts from plain tickers", () => {
  assert.equal(isOsiSymbol("IOVA261016C00012500"), true);
  assert.equal(isOsiSymbol("iova261016c00012500"), true, "case-insensitive");
  assert.equal(isOsiSymbol("IOVA"), false);
  assert.equal(isOsiSymbol("VIX"), false);
});

test("osiRoot extracts the underlying without a full parse, and declines plain tickers", () => {
  assert.equal(osiRoot("IOVA261016C00012500"), "IOVA");
  assert.equal(osiRoot("SPY"), undefined);
});

test("describeContract renders a readable label for a report line", () => {
  assert.equal(
    describeContract(parseOsiSymbol("SPY260917C00660000")),
    "SPY $660 call exp 2026-09-17",
  );
  assert.equal(
    describeContract(parseOsiSymbol("IOVA261016C00012500")),
    "IOVA $12.50 call exp 2026-10-16",
  );
});
