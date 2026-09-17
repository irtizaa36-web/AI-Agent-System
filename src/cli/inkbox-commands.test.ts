import { test } from "node:test";
import assert from "node:assert/strict";
import { feedbackCheckProfileFor, parsePort } from "./inkbox-commands";

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

test("feedbackCheckProfileFor triggers only for message.received, with the loop on and a profile set", () => {
  assert.equal(feedbackCheckProfileFor("message.received", true, "shivani"), "shivani");
});

test("feedbackCheckProfileFor ignores every other event type", () => {
  assert.equal(feedbackCheckProfileFor("message.sent", true, "shivani"), undefined);
  assert.equal(feedbackCheckProfileFor("message.delivered", true, "shivani"), undefined);
  assert.equal(feedbackCheckProfileFor("message.bounced", true, "shivani"), undefined);
});

test("feedbackCheckProfileFor does nothing while the loop is disabled", () => {
  assert.equal(feedbackCheckProfileFor("message.received", false, "shivani"), undefined);
});

test("feedbackCheckProfileFor never guesses a profile when none is configured", () => {
  assert.equal(feedbackCheckProfileFor("message.received", true, undefined), undefined);
  assert.equal(feedbackCheckProfileFor("message.received", true, ""), undefined);
  assert.equal(feedbackCheckProfileFor("message.received", true, "   "), undefined);
});
