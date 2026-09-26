import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, checkSessionHealth, classifyPage, Pacer, pace, readWithOneRetry, DEFAULT_PACE_MS } from "./page-health";
import { FakeBrowserClient } from "./fake-client";

const CHROME = "Home  Jobs  Companies  Salaries  Sign in  Filters: Remote, Full-time  Sort by: relevance  ".repeat(4);
const REAL_RESULTS = CHROME + "Marketing Manager — Acme — Remote — $90k. Growth Lead — Globex — NYC.";

test("classifyPage: a blank page is blocked", () => {
  assert.equal(classifyPage(""), "blocked");
  assert.equal(classifyPage("   \n  "), "blocked");
});

test("classifyPage: a crash or error shell is blocked, not quiet", () => {
  assert.equal(classifyPage("Something went wrong. Try reloading. ".repeat(8)), "blocked");
  assert.equal(classifyPage("Aw, Snap! Something went wrong while displaying this webpage. Error code: RESULT_CODE_HUNG " + "x ".repeat(100)), "blocked");
  assert.equal(classifyPage({ text: REAL_RESULTS, httpStatus: 429 }), "blocked");
  assert.equal(classifyPage({ text: REAL_RESULTS, finalUrl: "https://x.com/i/flow/login" }, { requestedUrl: "https://x.com/home" }), "blocked");
});

test("classifyPage: real chrome with zero results is empty; real chrome with results is ok", () => {
  assert.equal(classifyPage(CHROME + "No jobs found matching your search."), "empty");
  assert.equal(classifyPage(REAL_RESULTS), "ok");
});

test("classifyPage: a long real page that merely mentions an error phrase stays ok", () => {
  assert.equal(classifyPage(REAL_RESULTS.repeat(5) + " Our captcha team is hiring."), "ok");
});

test("the circuit breaker trips on the 3rd consecutive block, not before", () => {
  const breaker = new CircuitBreaker();
  breaker.record("a.test", "blocked");
  breaker.record("a.test", "error");
  assert.equal(breaker.isOpen("a.test"), false);
  breaker.record("a.test", "blocked");
  assert.equal(breaker.isOpen("a.test"), true);
});

test("the circuit breaker resets on an ok (or empty) result", () => {
  const breaker = new CircuitBreaker();
  breaker.record("a.test", "blocked");
  breaker.record("a.test", "blocked");
  breaker.record("a.test", "ok");
  breaker.record("a.test", "blocked");
  breaker.record("a.test", "blocked");
  assert.equal(breaker.isOpen("a.test"), false);
  breaker.record("a.test", "empty");
  assert.equal(breaker.consecutiveFailures("a.test"), 0);
});

test("the circuit breaker keeps state per domain", () => {
  const breaker = new CircuitBreaker();
  for (let i = 0; i < 3; i++) breaker.record("a.test", "blocked");
  breaker.record("b.test", "blocked");
  assert.equal(breaker.isOpen("a.test"), true);
  assert.equal(breaker.isOpen("b.test"), false);
});

test("pace defaults to the sweep's delay and uses the injected sleep, never a real one", async () => {
  const sleeps: number[] = [];
  await pace(undefined, async (ms) => void sleeps.push(ms));
  assert.deepEqual(sleeps, [DEFAULT_PACE_MS]);
  assert.equal(DEFAULT_PACE_MS, 4000);
});

test("Pacer waits between requests but not before the first", async () => {
  const sleeps: number[] = [];
  const pacer = new Pacer(250, async (ms) => void sleeps.push(ms));
  await pacer.beforeRequest();
  assert.deepEqual(sleeps, []);
  await pacer.beforeRequest();
  await pacer.beforeRequest();
  assert.deepEqual(sleeps, [250, 250]);
});

test("checkSessionHealth: a probe that throws or comes back blank is unhealthy; a real page is healthy", async () => {
  const client = new FakeBrowserClient("s", new Map([["https://ok.test/", REAL_RESULTS], ["https://blank.test/", ""]]));
  assert.equal((await checkSessionHealth(client, "https://ok.test/")).healthy, true);
  const blank = await checkSessionHealth(client, "https://blank.test/");
  assert.deepEqual([blank.healthy, blank.status], [false, "blocked"]);
  const thrown = await checkSessionHealth(client, "https://missing.test/");
  assert.deepEqual([thrown.healthy, thrown.status], [false, "error"]);
});

test("readWithOneRetry paces before its single retry and stops there", async () => {
  const sleeps: number[] = [];
  const client = new FakeBrowserClient("s", new Map([["https://a.test/p", ["", "", REAL_RESULTS]]]));
  const result = await readWithOneRetry(client, "https://a.test/p", { retryDelayMs: 10, sleep: async (ms) => void sleeps.push(ms) });
  assert.equal(result.status, "blocked");
  assert.equal(result.attempts, 2);
  assert.equal(client.requestedUrls.length, 2);
  assert.deepEqual(sleeps, [10]);
});
