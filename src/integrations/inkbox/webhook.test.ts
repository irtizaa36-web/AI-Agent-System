import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  checkTimestampFreshness,
  extractWebhookHeaders,
  parseWebhookPayload,
  ReplayGuard,
  verifyBearerToken,
  verifySignature,
  type WebhookHeaders,
} from "./webhook";

const SIGNING_KEY = "test-signing-key";
const REQUEST_ID = "req-abc-123";
const TIMESTAMP = "1741737600";
const BODY = Buffer.from('{"event":"message.received","data":{}}');

function sign(key: string, requestId: string, timestamp: string, body: Buffer): string {
  const message = Buffer.concat([Buffer.from(`${requestId}.${timestamp}.`), body]);
  return `sha256=${createHmac("sha256", key).update(message).digest("hex")}`;
}

function headers(overrides: Partial<WebhookHeaders> = {}): WebhookHeaders {
  return {
    signature: sign(SIGNING_KEY, REQUEST_ID, TIMESTAMP, BODY),
    requestId: REQUEST_ID,
    timestamp: TIMESTAMP,
    authorization: undefined,
    ...overrides,
  };
}

test("verifySignature accepts a correctly signed request", () => {
  assert.equal(verifySignature(BODY, headers(), SIGNING_KEY).ok, true);
});

test("verifySignature accepts a whsec_-prefixed signing key", () => {
  const signed = sign(SIGNING_KEY, REQUEST_ID, TIMESTAMP, BODY);
  assert.equal(verifySignature(BODY, headers({ signature: signed }), `whsec_${SIGNING_KEY}`).ok, true);
});

test("verifySignature rejects a tampered body", () => {
  const result = verifySignature(Buffer.from('{"event":"message.sent","data":{}}'), headers(), SIGNING_KEY);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /mismatch/);
});

test("verifySignature rejects the wrong signing key", () => {
  assert.equal(verifySignature(BODY, headers(), "wrong-key").ok, false);
});

test("verifySignature rejects a signature for a different request id (no cross-request replay)", () => {
  assert.equal(verifySignature(BODY, headers({ requestId: "different-id" }), SIGNING_KEY).ok, false);
});

test("verifySignature rejects a signature for a different timestamp", () => {
  assert.equal(verifySignature(BODY, headers({ timestamp: "9999999999" }), SIGNING_KEY).ok, false);
});

test("verifySignature rejects when the sha256= prefix is missing", () => {
  const raw = sign(SIGNING_KEY, REQUEST_ID, TIMESTAMP, BODY).slice("sha256=".length);
  assert.equal(verifySignature(BODY, headers({ signature: raw }), SIGNING_KEY).ok, false);
});

test("verifySignature rejects when headers are missing entirely", () => {
  assert.equal(verifySignature(BODY, { signature: undefined, requestId: undefined, timestamp: undefined, authorization: undefined }, SIGNING_KEY).ok, false);
});

test("verifySignature never throws on a malformed, wrong-length signature value", () => {
  assert.doesNotThrow(() => verifySignature(BODY, headers({ signature: "sha256=nothex" }), SIGNING_KEY));
});

test("extractWebhookHeaders normalizes header casing", () => {
  const extracted = extractWebhookHeaders({
    "X-Inkbox-Signature": "sha256=abc",
    "X-Inkbox-Request-ID": "r1",
    "X-Inkbox-Timestamp": "123",
    Authorization: "Bearer tok",
  });
  assert.deepEqual(extracted, { signature: "sha256=abc", requestId: "r1", timestamp: "123", authorization: "Bearer tok" });
});

test("extractWebhookHeaders takes the first value of a repeated header", () => {
  const extracted = extractWebhookHeaders({ "x-inkbox-signature": ["sha256=a", "sha256=b"] });
  assert.equal(extracted.signature, "sha256=a");
});

test("checkTimestampFreshness accepts a timestamp within tolerance", () => {
  const now = new Date(1741737600 * 1000 + 60_000);
  assert.equal(checkTimestampFreshness(TIMESTAMP, 300, now).ok, true);
});

test("checkTimestampFreshness rejects a timestamp outside tolerance", () => {
  const now = new Date(1741737600 * 1000 + 10 * 60_000);
  const result = checkTimestampFreshness(TIMESTAMP, 300, now);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /outside the 300s tolerance/);
});

test("checkTimestampFreshness rejects a missing or non-numeric timestamp", () => {
  assert.equal(checkTimestampFreshness(undefined, 300).ok, false);
  assert.equal(checkTimestampFreshness("not-a-number", 300).ok, false);
});

test("ReplayGuard allows a request id once, then rejects a repeat", () => {
  const guard = new ReplayGuard(300);
  const now = new Date();
  assert.equal(guard.checkAndRecord("req-1", now), true);
  assert.equal(guard.checkAndRecord("req-1", now), false);
});

test("ReplayGuard treats different request ids independently", () => {
  const guard = new ReplayGuard(300);
  const now = new Date();
  assert.equal(guard.checkAndRecord("req-1", now), true);
  assert.equal(guard.checkAndRecord("req-2", now), true);
});

test("ReplayGuard forgets an id once it's well outside the tolerance window", () => {
  const guard = new ReplayGuard(60);
  const start = new Date(0);
  assert.equal(guard.checkAndRecord("req-1", start), true);
  const later = new Date(start.getTime() + 10 * 60_000);
  assert.equal(guard.checkAndRecord("req-1", later), true);
});

test("verifyBearerToken passes through when no token is configured (optional check)", () => {
  assert.equal(verifyBearerToken(undefined, undefined).ok, true);
  assert.equal(verifyBearerToken("Bearer anything", undefined).ok, true);
});

test("verifyBearerToken rejects a missing Authorization header when a token is configured", () => {
  assert.equal(verifyBearerToken(undefined, "secret-token").ok, false);
});

test("verifyBearerToken rejects a malformed Authorization header", () => {
  assert.equal(verifyBearerToken("Basic abc123", "secret-token").ok, false);
});

test("verifyBearerToken rejects the wrong token", () => {
  assert.equal(verifyBearerToken("Bearer wrong-token", "secret-token").ok, false);
});

test("verifyBearerToken accepts the exact configured token", () => {
  assert.equal(verifyBearerToken("Bearer secret-token", "secret-token").ok, true);
});

test("parseWebhookPayload parses a well-formed event", () => {
  const parsed = parseWebhookPayload('{"event":"message.received","data":{"id":"m1"}}');
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.event.event, "message.received");
    assert.deepEqual(parsed.event.data, { id: "m1" });
  }
});

test("parseWebhookPayload defaults data to {} when absent", () => {
  const parsed = parseWebhookPayload('{"event":"message.sent"}');
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.event.data, {});
});

test("parseWebhookPayload rejects invalid JSON", () => {
  const parsed = parseWebhookPayload("not json");
  assert.equal(parsed.ok, false);
});

test("parseWebhookPayload rejects a non-object body", () => {
  const parsed = parseWebhookPayload("[1,2,3]");
  assert.equal(parsed.ok, false);
});

test("parseWebhookPayload rejects a missing event field", () => {
  const parsed = parseWebhookPayload('{"data":{}}');
  assert.equal(parsed.ok, false);
});

test("parseWebhookPayload flags an unrecognized event type as unknownEvent rather than a hard error", () => {
  const parsed = parseWebhookPayload('{"event":"message.snoozed","data":{}}');
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.unknownEvent, true);
});
