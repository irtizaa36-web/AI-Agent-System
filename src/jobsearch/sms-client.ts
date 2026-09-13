/**
 * Sends the daily digest as a text, through Inkbox's Phone API — read-only
 * everywhere else in this pipeline, this is the one place it sends anything
 * to a real device, so it exists as its own small, explicitly-gated port
 * (ADR 0016), the same separation ADR 0004 draws between read/draft/send
 * everywhere else in this project.
 *
 * The request shape below (`POST /numbers/{phoneNumberId}/texts`, header
 * `X-API-Key`, base `https://inkbox.ai/api/v1/phone`) is copied from the
 * installed `@inkbox/sdk` (v0.6.6, `dist/phone/resources/texts.js` and
 * `dist/inkbox.js`), not guessed — the same discipline
 * `integrations/inkbox/real-client.ts` used for the Mail API. One thing
 * worth flagging rather than quietly living with: that Mail client sends
 * `X-Service-Token`, while the currently-installed SDK uses `X-API-Key` for
 * every resource, Mail included. This module follows what the SDK actually
 * does today; whether the Mail client's header needs updating too is a
 * separate question, out of scope here, and not something this change
 * touches.
 *
 * Sending requires real-world prerequisites this code cannot verify or
 * satisfy on its own: an Inkbox phone number assigned to the sending
 * identity, and the destination recorded as opted in via Inkbox's own
 * `smsOptIns` — which itself requires an active, carrier-registered 10DLC
 * campaign on the account. None of that is something to opt someone into
 * from inside a scheduled job; it's a deliberate, one-time action taken
 * through Inkbox directly, before this is ever turned on.
 */

const DEFAULT_BASE_URL = "https://inkbox.ai";
const API_ROOT_SUFFIX = "/api/v1/phone";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface SendTextResult {
  readonly status: "queued" | "sent" | string;
  readonly id?: string;
}

export class SmsRecipientBlockedError extends Error {
  constructor(readonly to: string) {
    super(`Inkbox refused to send to ${to}: blocked by an outbound contact rule, or not yet recorded as opted in.`);
    this.name = "SmsRecipientBlockedError";
  }
}

export class InkboxSmsApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly detail: string,
  ) {
    super(`Inkbox phone API error (HTTP ${statusCode}): ${detail}`);
    this.name = "InkboxSmsApiError";
  }
}

export interface SmsClient {
  /** Sends one text. Never called by anything in this pipeline except an explicit, config-gated digest-delivery step. */
  send(to: string, text: string): Promise<SendTextResult>;
}

export interface InkboxSmsClientOptions {
  readonly apiKey: string;
  /** UUID of the Inkbox phone number to send from — see numbers.list() on the Inkbox dashboard/API, not something this code can discover on its own. */
  readonly phoneNumberId: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export class InkboxSmsClient implements SmsClient {
  constructor(private readonly options: InkboxSmsClientOptions) {}

  async send(to: string, text: string): Promise<SendTextResult> {
    const apiRoot = `${(this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")}${API_ROOT_SUFFIX}`;
    const url = `${apiRoot}/numbers/${encodeURIComponent(this.options.phoneNumberId)}/texts`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "X-API-Key": this.options.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ to, text }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let detail: unknown;
      try {
        detail = await response.json();
      } catch {
        detail = response.statusText;
      }
      if (response.status === 403 && typeof detail === "object" && detail !== null && (detail as { error?: string }).error === "recipient_blocked") {
        throw new SmsRecipientBlockedError(to);
      }
      throw new InkboxSmsApiError(response.status, typeof detail === "string" ? detail : JSON.stringify(detail));
    }

    const body = (await response.json()) as { status?: string; id?: string };
    return { status: body.status ?? "queued", id: body.id };
  }
}

/** Deterministic stand-in for tests — records every send, never touches the network. */
export class FakeSmsClient implements SmsClient {
  readonly sent: { to: string; text: string }[] = [];
  constructor(private readonly behavior: "succeed" | "blocked" = "succeed") {}

  async send(to: string, text: string): Promise<SendTextResult> {
    if (this.behavior === "blocked") throw new SmsRecipientBlockedError(to);
    this.sent.push({ to, text });
    return { status: "queued", id: `fake-${this.sent.length}` };
  }
}

/**
 * The real client when every required value is configured, otherwise
 * `undefined` — never a half-configured client, same pattern as
 * `createInkboxClientFromEnv` and `createScoringClientFromEnv`.
 */
export function createSmsClientFromEnv(): SmsClient | undefined {
  const apiKey = process.env["INKBOX_API_KEY"];
  const phoneNumberId = process.env["INKBOX_SMS_PHONE_NUMBER_ID"];
  if (!apiKey || !phoneNumberId) return undefined;

  return new InkboxSmsClient({
    apiKey,
    phoneNumberId,
    baseUrl: process.env["INKBOX_API_BASE_URL"],
  });
}
