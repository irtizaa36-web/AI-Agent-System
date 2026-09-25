import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { authHeaders, createPolymarketClientFromEnv, createRealPolymarketClient, privateKeyFromSecret, PolymarketAPIError } from "./real-client";
import type { LimitOrderRequest } from "./client";

const ORDER: LimitOrderRequest = {
  marketSlug: "chiefs-super-bowl-lx",
  intent: "ORDER_INTENT_BUY_LONG",
  type: "ORDER_TYPE_LIMIT",
  price: { value: "0.55", currency: "USD" },
  quantity: 100,
  tif: "TIME_IN_FORCE_GOOD_TILL_CANCEL",
};

/** A fresh Ed25519 key, exported as the raw base64 seed Polymarket issues. */
function testSecret(): { secret: string; publicKey: ReturnType<typeof createPublicKey> } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  return { secret: der.subarray(der.length - 32).toString("base64"), publicKey };
}

async function withFetch<T>(handler: (url: string, init: RequestInit) => Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(input.toString(), init ?? {})) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("authHeaders signs timestamp + METHOD + path with the account's Ed25519 key", () => {
  const { secret, publicKey } = testSecret();
  const headers = authHeaders("key-1", privateKeyFromSecret(secret), "POST", "/v1/orders", 1_700_000_000_000);

  assert.equal(headers["X-PM-Access-Key"], "key-1");
  assert.equal(headers["X-PM-Timestamp"], "1700000000000");
  const signature = Buffer.from(headers["X-PM-Signature"] as string, "base64");
  assert.ok(verify(null, Buffer.from("1700000000000POST/v1/orders"), publicKey, signature));
});

test("a 64-byte seed+public-key secret signs the same as its 32-byte seed", () => {
  const { secret, publicKey } = testSecret();
  const long = Buffer.concat([Buffer.from(secret, "base64"), Buffer.alloc(32)]).toString("base64");
  const headers = authHeaders("k", privateKeyFromSecret(long), "POST", "/p", 1);
  assert.ok(verify(null, Buffer.from("1POST/p"), publicKey, Buffer.from(headers["X-PM-Signature"] as string, "base64")));
});

test("placeOrder POSTs the order body to /v1/orders and returns its id", async () => {
  const { secret } = testSecret();
  const client = createRealPolymarketClient({ keyId: "key-1", secretKey: secret, baseUrl: "https://api.test" });
  const calls: { url: string; init: RequestInit }[] = [];

  const result = await withFetch(
    (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "ord-9", executions: [{}] }), { status: 200 });
    },
    () => client.placeOrder(ORDER),
  );

  assert.deepEqual(result, { id: "ord-9", executionCount: 1 });
  assert.equal(calls[0]?.url, "https://api.test/v1/orders");
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0]?.init.body as string), ORDER);
});

test("previewOrder wraps the order as { request } and reads back market metadata", async () => {
  const { secret } = testSecret();
  const client = createRealPolymarketClient({ keyId: "k", secretKey: secret, baseUrl: "https://api.test" });
  let sentBody: unknown;

  const preview = await withFetch(
    (url, init) => {
      assert.equal(url, "https://api.test/v1/order/preview");
      sentBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ order: { ...ORDER, state: "ORDER_STATE_NEW", marketMetadata: { title: "Chiefs win Super Bowl LX", outcome: "Yes" } } }),
        { status: 200 },
      );
    },
    () => client.previewOrder(ORDER),
  );

  assert.deepEqual(sentBody, { request: ORDER });
  assert.equal(preview.marketTitle, "Chiefs win Super Bowl LX");
  assert.equal(preview.state, "ORDER_STATE_NEW");
});

test("an API error surfaces Polymarket's message and status", async () => {
  const { secret } = testSecret();
  const client = createRealPolymarketClient({ keyId: "k", secretKey: secret, baseUrl: "https://api.test" });

  await withFetch(
    () => new Response(JSON.stringify({ message: "insufficient buying power" }), { status: 400 }),
    () =>
      assert.rejects(client.placeOrder(ORDER), (err: unknown) => {
        assert.ok(err instanceof PolymarketAPIError);
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /insufficient buying power/);
        return true;
      }),
  );
});

test("createPolymarketClientFromEnv needs both credentials", () => {
  const saved = { id: process.env["POLYMARKET_KEY_ID"], secret: process.env["POLYMARKET_SECRET_KEY"] };
  try {
    delete process.env["POLYMARKET_SECRET_KEY"];
    process.env["POLYMARKET_KEY_ID"] = "k";
    assert.equal(createPolymarketClientFromEnv(), undefined);
    process.env["POLYMARKET_SECRET_KEY"] = testSecret().secret;
    assert.ok(createPolymarketClientFromEnv());
  } finally {
    if (saved.id === undefined) delete process.env["POLYMARKET_KEY_ID"];
    else process.env["POLYMARKET_KEY_ID"] = saved.id;
    if (saved.secret === undefined) delete process.env["POLYMARKET_SECRET_KEY"];
    else process.env["POLYMARKET_SECRET_KEY"] = saved.secret;
  }
});
