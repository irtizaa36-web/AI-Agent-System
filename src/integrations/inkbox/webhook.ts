import { createHmac, timingSafeEqual } from "node:crypto";

/** Where the Inkbox webhook tunnel delivers events. Fixed by the tunnel configuration, not environment-driven. */
export const INKBOX_WEBHOOK_PATH = "/inkbox/mail";

export const INKBOX_EVENT_TYPES = [
  "message.received",
  "message.sent",
  "message.forwarded",
  "message.delivered",
  "message.bounced",
  "message.failed",
] as const;

export type InkboxEventType = (typeof INKBOX_EVENT_TYPES)[number];

export function isInkboxEventType(value: string): value is InkboxEventType {
  return (INKBOX_EVENT_TYPES as readonly string[]).includes(value);
}

export interface InkboxWebhookEvent {
  readonly event: InkboxEventType;
  readonly data: Record<string, unknown>;
}

export type ParsedWebhookPayload =
  | { readonly ok: true; readonly event: InkboxWebhookEvent }
  | { readonly ok: false; readonly reason: string; readonly unknownEvent?: boolean };

/**
 * Pure JSON/shape parsing — no verification here (see verifySignature). An
 * unrecognized-but-well-formed event type is reported via `unknownEvent`
 * rather than as a hard failure, so a future Inkbox event type this project
 * doesn't handle yet gets acknowledged (200) instead of retried forever.
 */
export function parseWebhookPayload(raw: string): ParsedWebhookPayload {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid JSON body" };
  }
  if (typeof json !== "object" || json === null) {
    return { ok: false, reason: "webhook body must be a JSON object" };
  }
  const body = json as Record<string, unknown>;
  // Confirmed against a real delivered payload: Inkbox names this field
  // `event_type`, not `event`.
  const event = body["event_type"];
  if (typeof event !== "string") {
    return { ok: false, reason: 'webhook body is missing a string "event_type" field' };
  }
  if (!isInkboxEventType(event)) {
    return { ok: false, reason: `unrecognized event type "${event}"`, unknownEvent: true };
  }
  const data = typeof body["data"] === "object" && body["data"] !== null ? (body["data"] as Record<string, unknown>) : {};
  return { ok: true, event: { event, data } };
}

export interface WebhookHeaders {
  readonly signature: string | undefined;
  readonly requestId: string | undefined;
  readonly timestamp: string | undefined;
  readonly authorization: string | undefined;
}

/** Normalizes header casing (HTTP headers are case-insensitive) and pulls out just what verification needs. */
export function extractWebhookHeaders(headers: Record<string, string | readonly string[] | undefined>): WebhookHeaders {
  const lower: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    lower[key.toLowerCase()] = Array.isArray(value) ? value[0] : (value as string | undefined);
  }
  return {
    signature: lower["x-inkbox-signature"],
    requestId: lower["x-inkbox-request-id"],
    timestamp: lower["x-inkbox-timestamp"],
    authorization: lower["authorization"],
  };
}

export interface CheckResult {
  readonly ok: boolean;
  readonly reason?: string;
}

function constantTimeEqualUtf8(expected: string, received: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(received);
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}

/**
 * Verifies `X-Inkbox-Signature` against the raw request body, reimplementing
 * Inkbox's own scheme exactly (see the official SDK,
 * github.com/VectorlyApp/inkbox, typescript/src/signing_keys.ts):
 * HMAC-SHA256, keyed by the signing key (with an optional `whsec_` prefix
 * stripped), over `${requestId}.${timestamp}.` followed by the raw body
 * bytes, hex-encoded and compared as `sha256=<hex>`.
 */
export function verifySignature(rawBody: Buffer, headers: WebhookHeaders, signingKey: string): CheckResult {
  const { signature, requestId, timestamp } = headers;
  if (!signature || !requestId || !timestamp) {
    return { ok: false, reason: "missing X-Inkbox-Signature, X-Inkbox-Request-ID, or X-Inkbox-Timestamp header" };
  }
  if (!signature.startsWith("sha256=")) {
    return { ok: false, reason: 'X-Inkbox-Signature must start with "sha256="' };
  }

  const key = signingKey.startsWith("whsec_") ? signingKey.slice("whsec_".length) : signingKey;
  const message = Buffer.concat([Buffer.from(`${requestId}.${timestamp}.`), rawBody]);
  const expected = createHmac("sha256", key).update(message).digest("hex");
  const received = signature.slice("sha256=".length);

  return constantTimeEqualUtf8(expected, received) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/**
 * Rejects a timestamp too far in the past or future. This — together with
 * ReplayGuard below — is the "timestamp and replay protection" layer that
 * sits on top of verifySignature: a valid signature alone only proves the
 * request was genuinely signed by Inkbox at some point, not that it's being
 * delivered for the first time or promptly.
 */
export function checkTimestampFreshness(timestampHeader: string | undefined, toleranceSeconds: number, now: Date = new Date()): CheckResult {
  if (!timestampHeader) return { ok: false, reason: "missing X-Inkbox-Timestamp header" };
  const seconds = Number(timestampHeader);
  if (!Number.isFinite(seconds)) return { ok: false, reason: "X-Inkbox-Timestamp is not a valid number" };
  const deltaSeconds = Math.abs(now.getTime() / 1000 - seconds);
  if (deltaSeconds > toleranceSeconds) {
    return { ok: false, reason: `timestamp is ${Math.round(deltaSeconds)}s outside the ${toleranceSeconds}s tolerance window` };
  }
  return { ok: true };
}

/**
 * Tracks which `X-Inkbox-Request-ID` values have already been processed, so
 * a retried/duplicated delivery (Inkbox retrying, or a captured request
 * replayed by an attacker) is never processed twice. Bounded to roughly
 * twice the timestamp tolerance window — a request older than that would
 * already be rejected by checkTimestampFreshness, so its id doesn't need to
 * be remembered forever.
 */
export class ReplayGuard {
  private readonly seenAtMs = new Map<string, number>();

  constructor(private readonly toleranceSeconds: number) {}

  /** Returns true (and records it) the first time an id is seen; false for a repeat. */
  checkAndRecord(requestId: string, now: Date = new Date()): boolean {
    this.prune(now);
    if (this.seenAtMs.has(requestId)) return false;
    this.seenAtMs.set(requestId, now.getTime());
    return true;
  }

  private prune(now: Date): void {
    const cutoffMs = now.getTime() - this.toleranceSeconds * 1000 * 2;
    for (const [id, seenAtMs] of this.seenAtMs) {
      if (seenAtMs < cutoffMs) this.seenAtMs.delete(id);
    }
  }
}

/**
 * Verifies the additional, optional bearer token from the Authorization
 * header. Unset `expectedToken` means this check is disabled entirely (the
 * token is optional, per INKBOX_WEBHOOK_AUTH_TOKEN being unset) — signature
 * verification above is what's actually load-bearing for authenticity.
 */
export function verifyBearerToken(authorizationHeader: string | undefined, expectedToken: string | undefined): CheckResult {
  if (!expectedToken) return { ok: true };
  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
    return { ok: false, reason: "missing or malformed Authorization header" };
  }
  const provided = authorizationHeader.slice("Bearer ".length);
  return constantTimeEqualUtf8(expectedToken, provided) ? { ok: true } : { ok: false, reason: "bearer token mismatch" };
}
