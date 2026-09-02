import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePort } from "./inkbox-commands";

test("parsePort falls back for undefined", () => {
  assert.equal(parsePort(undefined, 8787), 8787);
});

test("parsePort falls back for a blank string (an untouched .env template line)", () => {
  assert.equal(parsePort("", 8787), 8787);
  assert.equal(parsePort("   ", 8787), 8787);
});

test("parsePort uses a real provided value", () => {
  assert.equal(parsePort("9000", 8787), 9000);
});
