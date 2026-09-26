import { test } from "node:test";
import assert from "node:assert/strict";
import { runXSearchSweep } from "./sweep";
import { FakeBrowserClient } from "../browser/fake-client";
import { xSearchUrl, type XTopic } from "./topics";

const noopSleep = async (): Promise<void> => {};

const TOPICS: readonly XTopic[] = [
  { name: "Topic A", query: "topic a" },
  { name: "Topic B", query: "topic b" },
  { name: "Topic C", query: "topic c" },
];

const HEALTH_URL = "https://x.com/home";
const HEALTHY_HOME_TEXT = "Home / For you / Following / " + "post ".repeat(60);
const GOOD_RESULT_TEXT = "post text ".repeat(40);
const BLANK_TEXT = "";

test("a healthy session with good results returns ok for every topic and never sleeps between calls other than pacing", async () => {
  const pages = new Map<string, string>([
    [HEALTH_URL, HEALTHY_HOME_TEXT],
    [xSearchUrl(TOPICS[0]!.query, { live: true }), GOOD_RESULT_TEXT],
    [xSearchUrl(TOPICS[1]!.query, { live: true }), GOOD_RESULT_TEXT],
    [xSearchUrl(TOPICS[2]!.query, { live: true }), GOOD_RESULT_TEXT],
  ]);
  const client = new FakeBrowserClient("x", pages);

  const sweep = await runXSearchSweep(client, { topics: TOPICS, sleep: noopSleep });

  assert.equal(sweep.sessionHealthy, true);
  assert.equal(sweep.results.length, 3);
  for (const result of sweep.results) {
    assert.equal(result.status, "ok");
    assert.equal(result.text, GOOD_RESULT_TEXT);
  }
});

test("an unhealthy session (blank health-check page) skips every topic with a clear note instead of reporting false blanks", async () => {
  const pages = new Map<string, string>([[HEALTH_URL, BLANK_TEXT]]);
  const client = new FakeBrowserClient("x", pages);

  const sweep = await runXSearchSweep(client, { topics: TOPICS, sleep: noopSleep });

  assert.equal(sweep.sessionHealthy, false);
  assert.equal(sweep.results.length, 3);
  for (const result of sweep.results) {
    assert.equal(result.status, "skipped");
    assert.match(result.note ?? "", /health check/);
  }
});

test("a session that throws on the health check (e.g. navigation timeout) is treated the same as a blank page", async () => {
  const client = new FakeBrowserClient("x", new Map()); // no fixture for the health-check URL => throws
  const sweep = await runXSearchSweep(client, { topics: TOPICS, sleep: noopSleep });
  assert.equal(sweep.sessionHealthy, false);
});

test("a blank Latest-tab result for one topic recovers via the Top-tab fallback", async () => {
  const pages = new Map<string, string>([
    [HEALTH_URL, HEALTHY_HOME_TEXT],
    [xSearchUrl(TOPICS[0]!.query, { live: true }), BLANK_TEXT],
    [xSearchUrl(TOPICS[0]!.query, { live: false }), GOOD_RESULT_TEXT],
  ]);
  const client = new FakeBrowserClient("x", pages);

  const sweep = await runXSearchSweep(client, { topics: [TOPICS[0]!], sleep: noopSleep });

  assert.equal(sweep.sessionHealthy, true);
  assert.equal(sweep.results[0]?.status, "ok");
  assert.equal(sweep.results[0]?.text, GOOD_RESULT_TEXT);
  assert.match(sweep.results[0]?.note ?? "", /Top-tab fallback/);
});

test("a topic blank on both Latest and Top tabs is reported as blocked, not padded as quiet", async () => {
  const pages = new Map<string, string>([
    [HEALTH_URL, HEALTHY_HOME_TEXT],
    [xSearchUrl(TOPICS[0]!.query, { live: true }), BLANK_TEXT],
    [xSearchUrl(TOPICS[0]!.query, { live: false }), BLANK_TEXT],
  ]);
  const client = new FakeBrowserClient("x", pages);

  const sweep = await runXSearchSweep(client, { topics: [TOPICS[0]!], sleep: noopSleep });

  assert.equal(sweep.results[0]?.status, "blocked");
});

test("the circuit breaker stops the sweep after three consecutive blocked topics, skipping the rest", async () => {
  const blockedTopics: readonly XTopic[] = [
    { name: "T1", query: "t1" },
    { name: "T2", query: "t2" },
    { name: "T3", query: "t3" },
    { name: "T4", query: "t4" },
    { name: "T5", query: "t5" },
  ];
  const pages = new Map<string, string>([[HEALTH_URL, HEALTHY_HOME_TEXT]]);
  // No fixtures for any topic's Latest/Top URLs => every attempt throws => every topic is blocked.
  const client = new FakeBrowserClient("x", pages);

  const sweep = await runXSearchSweep(client, { topics: blockedTopics, sleep: noopSleep, circuitBreakerThreshold: 3 });

  assert.equal(sweep.results.length, 5);
  assert.deepEqual(sweep.results.slice(0, 3).map((r) => r.status), ["blocked", "blocked", "blocked"]);
  assert.deepEqual(sweep.results.slice(3).map((r) => r.status), ["skipped", "skipped"]);
  assert.match(sweep.results[3]?.note ?? "", /stopped early/);
});

test("a recovered topic resets the consecutive-blocked counter so the circuit breaker doesn't trip on an unrelated earlier blip", async () => {
  const topics: readonly XTopic[] = [
    { name: "T1", query: "t1" },
    { name: "T2", query: "t2" },
    { name: "T3", query: "t3" },
    { name: "T4", query: "t4" },
  ];
  const pages = new Map<string, string>([
    [HEALTH_URL, HEALTHY_HOME_TEXT],
    [xSearchUrl("t2", { live: true }), GOOD_RESULT_TEXT],
    // t1, t3, t4 have no fixtures at all => blocked, but t2 in between resets the streak.
  ]);
  const client = new FakeBrowserClient("x", pages);

  const sweep = await runXSearchSweep(client, { topics, sleep: noopSleep, circuitBreakerThreshold: 2 });

  assert.deepEqual(
    sweep.results.map((r) => r.status),
    ["blocked", "ok", "blocked", "blocked"],
  );
});
