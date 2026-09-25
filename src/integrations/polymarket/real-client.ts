import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import type { LimitOrderRequest, PlacedOrder, PolymarketClient, PreviewedOrder } from "./client";

/**
 * The real Polymarket US trading API, called directly with `fetch` and
 * signed with Node's built-in Ed25519 — no `polymarket-us` SDK dependency
 * (ADR 0002, same reasoning as the Inkbox client in ADR 0006). Endpoints and
 * the signing scheme are taken from Polymarket's own published SDK
 * (npm `polymarket-us` 0.1.1, src/auth.ts and src/resources/orders.ts):
 * each authenticated request carries X-PM-Access-Key, X-PM-Timestamp (ms),
 * and X-PM-Signature = base64(Ed25519(timestamp + METHOD + path)).
 */
const DEFAULT_BASE_URL = "https://api.polymarket.us";
const DEFAULT_TIMEOUT_MS = 30_000;
/** DER prefix that wraps a raw 32-byte Ed25519 seed as a PKCS#8 private key. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export class PolymarketAPIError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, detail: string) {
    super(`Polymarket API error (HTTP ${statusCode}): ${detail}`);
    this.name = "PolymarketAPIError";
    this.statusCode = statusCode;
  }
}

/** Accepts a base64 secret that is either the 32-byte seed or the 64-byte seed+public-key form, like the SDK does. */
export function privateKeyFromSecret(secretKeyBase64: string): KeyObject {
  const bytes = Buffer.from(secretKeyBase64, "base64");
  if (bytes.length !== 32 && bytes.length !== 64) {
    throw new Error("POLYMARKET_SECRET_KEY must be a base64 Ed25519 key of 32 or 64 bytes");
  }
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, bytes.subarray(0, 32)]), format: "der", type: "pkcs8" });
}

/** Exported for direct unit testing — pure apart from the clock. */
export function authHeaders(keyId: string, privateKey: KeyObject, method: string, path: string, now: number = Date.now()): Record<string, string> {
  const timestamp = String(now);
  const signature = sign(null, Buffer.from(`${timestamp}${method}${path}`), privateKey).toString("base64");
  return { "X-PM-Access-Key": keyId, "X-PM-Timestamp": timestamp, "X-PM-Signature": signature };
}

interface RawOrder {
  readonly marketSlug: string;
  readonly intent: string;
  readonly price: { readonly value: string; readonly currency: string };
  readonly quantity: number;
  readonly state: string;
  readonly marketMetadata?: { readonly title?: string; readonly outcome?: string };
}

export interface RealPolymarketClientOptions {
  readonly keyId: string;
  readonly secretKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export function createRealPolymarketClient(options: RealPolymarketClientOptions): PolymarketClient {
  const privateKey = privateKeyFromSecret(options.secretKey);
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, baseUrl);
    const headers = { "Content-Type": "application/json", ...authHeaders(options.keyId, privateKey, "POST", url.pathname) };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) {
      let detail = text || response.statusText;
      try {
        const data = JSON.parse(text) as { message?: string; error?: string };
        detail = data.message ?? data.error ?? detail;
      } catch {
        // non-JSON error body: keep the raw text
      }
      throw new PolymarketAPIError(response.status, detail);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    async previewOrder(request: LimitOrderRequest): Promise<PreviewedOrder> {
      const { order } = await post<{ order: RawOrder }>("/v1/order/preview", { request });
      return {
        marketSlug: order.marketSlug,
        intent: order.intent,
        price: order.price,
        quantity: order.quantity,
        state: order.state,
        ...(order.marketMetadata?.title ? { marketTitle: order.marketMetadata.title } : {}),
        ...(order.marketMetadata?.outcome ? { marketOutcome: order.marketMetadata.outcome } : {}),
      };
    },

    async placeOrder(request: LimitOrderRequest): Promise<PlacedOrder> {
      const result = await post<{ id: string; executions?: readonly unknown[] }>("/v1/orders", request);
      return { id: result.id, executionCount: result.executions?.length ?? 0 };
    },
  };
}

/**
 * Returns a real client only when both POLYMARKET_KEY_ID and
 * POLYMARKET_SECRET_KEY are set — never a half-configured one.
 */
export function createPolymarketClientFromEnv(): PolymarketClient | undefined {
  const keyId = process.env["POLYMARKET_KEY_ID"];
  const secretKey = process.env["POLYMARKET_SECRET_KEY"];
  if (!keyId || !secretKey) return undefined;
  return createRealPolymarketClient({ keyId, secretKey });
}

/**
 * Stands in when no credentials are configured. Unlike Inkbox, there is
 * deliberately no fake fallback here: a fake that "placed" an order would
 * report a trade that never happened.
 */
export class UnconfiguredPolymarketClient implements PolymarketClient {
  async previewOrder(): Promise<PreviewedOrder> {
    throw new Error("Polymarket is not configured: set POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY");
  }

  async placeOrder(): Promise<PlacedOrder> {
    throw new Error("Polymarket is not configured: set POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY");
  }
}
