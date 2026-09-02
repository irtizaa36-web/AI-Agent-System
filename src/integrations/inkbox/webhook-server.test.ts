import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Registry } from "../../registry/registry";
import { InMemoryRunStore } from "../../store/run-store";
import { FakeProvider } from "../../providers/fake";
import { FakeInkboxClient } from "./fake-client";
import { InMemoryForwardingLog } from "./forwarding-log";
import { InMemoryMessageEventLog } from "./message-event-log";
import { startInkboxWebhookServer } from "./webhook-server";
import { INKBOX_WEBHOOK_PATH, type InkboxEventType } from "./webhook";
import type { WebhookHandlerDeps } from "./webhook-handler";

const SIGNING_KEY = "test-signing-key";

function sign(key: string, requestId: string, timestamp: string, body: string): string {
  const message = Buffer.concat([Buffer.from(`${requestId}.${timestamp}.`), Buffer.from(body)]);
  return `sha256=${createHmac("sha256", key).update(message).digest("hex")}`;
}

function buildDeps(): WebhookHandlerDeps {
  const registry = new Registry();
  registry.registerProvider(new FakeProvider([]));
  return {
    inkboxClient: new FakeInkboxClient("toozy@example.test"),
    forwardingLog: new InMemoryForwardingLog(),
    messageEventLog: new InMemoryMessageEventLog(),
    registry,
    store: new InMemoryRunStore(),
  };
}

async function withServer(
  opts: { authToken?: string } = {},
  fn: (baseUrl: string, events: { event: string; actions: readonly string[] }[]) => Promise<void>,
): Promise<void> {
  const events: { event: string; actions: readonly string[] }[] = [];
  const { server, port } = await startInkboxWebhookServer(buildDeps(), {
    path: INKBOX_WEBHOOK_PATH,
    port: 0,
    signingKey: SIGNING_KEY,
    authToken: opts.authToken,
    onEvent: (result) => events.push(result),
  });
  try {
    await fn(`http://localhost:${port}`, events);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function signedRequestInit(event: InkboxEventType, data: Record<string, unknown>, requestId = "req-1", timestamp = String(Math.floor(Date.now() / 1000))) {
  const body = JSON.stringify({ event_type: event, data });
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-inkbox-signature": sign(SIGNING_KEY, requestId, timestamp, body),
      "x-inkbox-request-id": requestId,
      "x-inkbox-timestamp": timestamp,
    },
    body,
  };
}

/**
 * The server now acknowledges (200) before processing (see webhook-server.ts:
 * a webhook sender must not be kept waiting on forwarding/resume work, which
 * can be slow or hang), so `onEvent` fires slightly after the response
 * resolves. Tests poll briefly rather than assuming synchronous completion.
 */
async function waitForEventCount(
  events: readonly unknown[],
  count: number,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a correctly signed request is accepted immediately, then processed and reported via onEvent", async () => {
  await withServer({}, async (baseUrl, events) => {
    const res = await fetch(`${baseUrl}${INKBOX_WEBHOOK_PATH}`, signedRequestInit("message.sent", { id: "m1" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    await waitForEventCount(events, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "message.sent");
  });
});

test("a request with no signature headers is rejected with 401", async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}${INKBOX_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "message.sent", data: {} }),
    });
    assert.equal(res.status, 401);
  });
});

test("a tampered body is rejected with 401 even though headers look well-formed", async () => {
  await withServer({}, async (baseUrl) => {
    const init = signedRequestInit("message.sent", { id: "m1" });
    const res = await fetch(`${baseUrl}${INKBOX_WEBHOOK_PATH}`, { ...init, body: JSON.stringify({ event: "message.sent", data: { id: "tampered" } }) });
    assert.equal(res.status, 401);
  });
});

test("a stale timestamp is rejected with 400 even with a correct signature for that timestamp", async () => {
  await withServer({}, async (baseUrl) => {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await fetch(`${baseUrl}${INKBOX_WEBHOOK_PATH}`, signedRequestInit("message.sent", { id: "m1" }, "req-1", staleTimestamp));
    assert.equal(res.status, 400);
  });
});

test("a replayed request id is acknowledged as a duplicate without reprocessing", async () => {
  await withServer({}, async (baseUrl, events) => {
    const init = signedRequestInit("message.sent", { id: "m1" }, "req-replay");
    const first = await fetch(`${baseUrl}${INKBOX_WEBHOOK_PATH}`, init);
    assert.equal(first.status, 200);
    await waitForEventCount(events, 1);
    const second = await fetch(`${baseUrl}${INKBOX_WEBHOOK_PATH}`, init);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { ok: true, duplicate: true });
    assert.equal(events.length, 1);
  });
});

test("an unrecognized-but-well-formed event type is acknowledged and ignored, not retried", async () => {
  await withServer({}, async (baseUrl, events) => {
    const res = await fetch(`${baseUrl}${INKBOX_WEBHOOK_PATH}`, signedRequestInit("message.snoozed" as InkboxEventType, { id: "m1" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ignored: true });
    assert.equal(events.length, 0);
  });
});

test("a missing bearer token is rejected with 401 when INKBOX_WEBHOOK_AUTH_TOKEN-equivalent is configured", async () => {
  await withServer({ authToken: "secret-token" }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}${INKBOX_WEBHOOK_PATH}`, signedRequestInit("message.sent", { id: "m1" }));
    assert.equal(res.status, 401);
  });
});

test("the correct bearer token, plus a valid signature, is accepted", async () => {
  await withServer({ authToken: "secret-token" }, async (baseUrl) => {
    const init = signedRequestInit("message.sent", { id: "m1" });
    const res = await fetch(`${baseUrl}${INKBOX_WEBHOOK_PATH}`, {
      ...init,
      headers: { ...init.headers, authorization: "Bearer secret-token" },
    });
    assert.equal(res.status, 200);
  });
});

test("an unrelated path returns 404", async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/not-the-webhook-path`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404);
  });
});

test("GET .../health responds 200 without requiring a signature, and reports no bearer token required", async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}${INKBOX_WEBHOOK_PATH}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; bearerTokenRequired: boolean };
    assert.equal(body.status, "ok");
    assert.equal(body.bearerTokenRequired, false);
  });
});

test("GET .../health reports bearerTokenRequired: true when an auth token is configured", async () => {
  await withServer({ authToken: "secret-token" }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}${INKBOX_WEBHOOK_PATH}/health`);
    const body = (await res.json()) as { bearerTokenRequired: boolean };
    assert.equal(body.bearerTokenRequired, true);
  });
});
