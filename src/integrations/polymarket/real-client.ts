import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import type { LimitOrderRequest, MarketQuote, MarketSummary, PlacedOrder, PolymarketClient, PreviewedOrder } from "./client";

/**
 * The real Polymarket US trading API, called directly with `fetch` and
 * signed with Node's built-in Ed25519 — no `polymarket-us` SDK dependency
 * (ADR 0002, same reasoning as the Inkbox client in ADR 0006). Endpoints and
 * the signing scheme are taken from Polymarket's own published SDK
 * (npm `polymarket-us` 0.1.1, src/auth.ts and src/resources/orders.ts):
 * each authenticated request carries X-PM-Access-Key, X-PM-Timestamp (ms),
 * and X-PM-Signature = base64(Ed25519(timestamp + METHOD + path)).
 *
 * Market search and quotes go to the public gateway and need no
 * credentials; previewing and placing orders go to the authenticated API.
 */
const DEFAULT_BASE_URL = "https://api.polymarket.us";
const DEFAULT_GATEWAY_URL = "https://gateway.polymarket.us";
const SEARCH_EVENT_LIMIT = 5;
/** One sports event can carry hundreds of prop markets; an agent only needs the first few matches. */
const SEARCH_MARKET_LIMIT = 30;
const NOT_CONFIGURED = "Polymarket trading is not configured: set POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY";
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

/**
 * Wire shapes as observed from the live public gateway on 2026-09-25 — they
 * differ from the SDK's own type declarations (markets carry `question` and
 * `title`, not `outcome`; the BBO body is wrapped in `marketData`).
 */
interface RawSearchEvent {
  readonly title: string;
  readonly markets?: readonly {
    readonly slug: string;
    readonly question?: string;
    readonly title?: string;
    readonly active: boolean;
    readonly closed: boolean;
  }[];
}

interface RawPrice {
  readonly value: string;
}

interface RawBBO {
  readonly marketSlug?: string;
  readonly state?: string;
  readonly bestBid?: RawPrice;
  readonly bestAsk?: RawPrice;
  readonly longQuote?: RawPrice;
  readonly shortQuote?: RawPrice;
  readonly lastTradePx?: RawPrice;
}

export interface RealPolymarketClientOptions {
  /** Both credentials are needed only for previewing and placing orders. */
  readonly keyId?: string;
  readonly secretKey?: string;
  readonly baseUrl?: string;
  readonly gatewayUrl?: string;
  readonly timeoutMs?: number;
}

export function createRealPolymarketClient(options: RealPolymarketClientOptions): PolymarketClient {
  const credentials =
    options.keyId && options.secretKey ? { keyId: options.keyId, privateKey: privateKeyFromSecret(options.secretKey) } : undefined;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(url: URL, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
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

  function get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, gatewayUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return request<T>(url, { method: "GET" });
  }

  function post<T>(path: string, body: unknown): Promise<T> {
    if (!credentials) return Promise.reject(new Error(NOT_CONFIGURED));
    const url = new URL(path, baseUrl);
    const headers = { "Content-Type": "application/json", ...authHeaders(credentials.keyId, credentials.privateKey, "POST", url.pathname) };
    return request<T>(url, { method: "POST", headers, body: JSON.stringify(body) });
  }

  return {
    async searchMarkets(query: string): Promise<readonly MarketSummary[]> {
      const { events } = await get<{ events?: readonly RawSearchEvent[] }>("/v1/search", { query, limit: String(SEARCH_EVENT_LIMIT), status: "active" });
      return (events ?? [])
        .flatMap((event) =>
          (event.markets ?? [])
            .filter((m) => m.active && !m.closed)
            .map((m) => ({
              eventTitle: event.title,
              marketSlug: m.slug,
              marketTitle: m.question ?? m.title ?? m.slug,
              outcome: m.title ?? "",
              active: m.active,
              closed: m.closed,
            })),
        )
        .slice(0, SEARCH_MARKET_LIMIT);
    },

    async getQuote(marketSlug: string): Promise<MarketQuote> {
      const body = await get<{ marketData?: RawBBO } & RawBBO>(`/v1/markets/${encodeURIComponent(marketSlug)}/bbo`);
      const bbo = body.marketData ?? body;
      return {
        marketSlug: bbo.marketSlug ?? marketSlug,
        ...(bbo.state ? { state: bbo.state } : {}),
        ...(bbo.bestBid ? { bestBid: bbo.bestBid.value } : {}),
        ...(bbo.bestAsk ? { bestAsk: bbo.bestAsk.value } : {}),
        ...(bbo.longQuote ? { longQuote: bbo.longQuote.value } : {}),
        ...(bbo.shortQuote ? { shortQuote: bbo.shortQuote.value } : {}),
        ...(bbo.lastTradePx ? { lastTrade: bbo.lastTradePx.value } : {}),
      };
    },

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
 * Always returns a real client: market search and quotes are public. Order
 * preview and placement additionally need both POLYMARKET_KEY_ID and
 * POLYMARKET_SECRET_KEY and fail with a clear error without them. There is
 * deliberately no fake fallback here, unlike Inkbox: a fake that "placed"
 * an order would report a trade that never happened.
 */
export function createPolymarketClientFromEnv(): PolymarketClient {
  const keyId = process.env["POLYMARKET_KEY_ID"];
  const secretKey = process.env["POLYMARKET_SECRET_KEY"];
  return createRealPolymarketClient({ ...(keyId ? { keyId } : {}), ...(secretKey ? { secretKey } : {}) });
}
