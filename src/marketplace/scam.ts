/**
 * Lightweight scam screen for inbound buyer messages (ADR 0024).
 * Flagged messages are NEVER auto-replied to — they escalate to Toozy.
 */

export interface ScreenResult {
  readonly flagged: boolean;
  readonly reasons: readonly string[];
}

interface Rule {
  readonly reason: string;
  readonly test: (body: string) => boolean;
}

const RULES: readonly Rule[] = [
  {
    reason: "code-request",
    test: (b) => /(\d[\s-]?){6}/.test(b) && /\b(code|verify|verification|confirm)\b/i.test(b),
  },
  {
    reason: "code-request",
    test: (b) => /\b(send|give|tell)\b[^.]{0,40}\b(code|verification code)\b/i.test(b),
  },
  {
    reason: "overpay-ship",
    test: (b) => /\b(ship|shipping|mover|agent|pickup agent)\b/i.test(b) && /\b(check|cashier|overpay|extra|refund)\b/i.test(b),
  },
  {
    reason: "ship-only",
    test: (b) => /\b(only|just)\b[^.]{0,30}\bship\b/i.test(b) && /\b(local|pickup|meet)\b/i.test(b) === false,
  },
  {
    reason: "paypal-email",
    test: (b) => /paypal/i.test(b) && /\bemail\b/i.test(b),
  },
  {
    reason: "qr-payment",
    test: (b) => /\bqr\b/i.test(b) && /\b(scan|payment|pay)\b/i.test(b),
  },
];

export function screenInbound(body: string): ScreenResult {
  const text = body ?? "";
  const reasons = RULES.filter((r) => r.test(text)).map((r) => r.reason);
  return { flagged: reasons.length > 0, reasons: [...new Set(reasons)] };
}
