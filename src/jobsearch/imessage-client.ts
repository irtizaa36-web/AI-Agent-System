/**
 * A candidate's own iMessage replies, read and answered through Inkbox's
 * iMessage API — same reasoning as sms-client.ts's own doc comment: read-only
 * everywhere else in this pipeline, this is one of the few places it sends
 * anything to a real device, so it exists as its own small, explicitly-gated
 * port (ADR 0016).
 *
 * The request/response shapes below (base `https://inkbox.ai/api/v1/imessage`,
 * header `X-API-Key`, `GET /messages` returning an array of message objects
 * keyed by `content`/`remote_number`/`direction`, `POST /messages` taking
 * `{to, text}` and returning `{"message": {...}}`) are confirmed against
 * Inkbox's own published API docs, not guessed — the same discipline this
 * project already holds itself to everywhere else (see sms-client.ts,
 * real-client.ts). `send_style` is deliberately omitted from the POST body:
 * the existing digest-send code in jobs-commands.ts already found that
 * including it causes a 422.
 */

const DEFAULT_BASE_URL = "https://inkbox.ai";
const API_ROOT_SUFFIX = "/api/v1/imessage";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LIST_LIMIT = 50;

export interface ImessageMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly direction: "inbound" | "outbound" | string;
  /** E.164 phone number, or null for a group thread's inbound message (see senderNumber). */
  readonly remoteNumber: string | null;
  readonly content: string;
  readonly service: "imessage" | "sms" | "rcs" | string;
  readonly isRead: boolean;
}

export interface SendImessageResult {
  readonly status: "pending" | "sent" | string;
  readonly id?: string;
}

export class InkboxImessageApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly detail: string,
  ) {
    super(`Inkbox iMessage API error (HTTP ${statusCode}): ${detail}`);
    this.name = "InkboxImessageApiError";
  }
}

export interface ImessageClient {
  /** Recent messages across every conversation for this identity, newest first — never filtered to unread, so idempotency is entirely the caller's job (see feedback-log.ts). */
  listMessages(options?: { readonly limit?: number }): Promise<readonly ImessageMessage[]>;
  /** Sends one text. Never called by anything in this pipeline except an explicit, config-gated feedback-reply or digest-delivery step. */
  send(to: string, text: string): Promise<SendImessageResult>;
}

export interface InkboxImessageClientOptions {
  readonly apiKey: string;
  /** UUID of the Inkbox agent identity to read/send as — see INKBOX_IDENTITY_ID, already required for the existing digest-iMessage send. */
  readonly identityId: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

function toMessage(raw: Record<string, unknown>): ImessageMessage {
  return {
    id: String(raw["id"] ?? ""),
    conversationId: String(raw["conversation_id"] ?? ""),
    direction: typeof raw["direction"] === "string" ? raw["direction"] : "unknown",
    remoteNumber: typeof raw["remote_number"] === "string" ? raw["remote_number"] : null,
    content: typeof raw["content"] === "string" ? raw["content"] : "",
    service: typeof raw["service"] === "string" ? raw["service"] : "imessage",
    isRead: raw["is_read"] === true,
  };
}

export class InkboxImessageClient implements ImessageClient {
  constructor(private readonly options: InkboxImessageClientOptions) {}

  private apiRoot(): string {
    return `${(this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")}${API_ROOT_SUFFIX}`;
  }

  private async request(method: string, url: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { "X-API-Key": this.options.apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
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
      throw new InkboxImessageApiError(response.status, typeof detail === "string" ? detail : JSON.stringify(detail));
    }

    return response.json();
  }

  async listMessages(options?: { readonly limit?: number }): Promise<readonly ImessageMessage[]> {
    const params = new URLSearchParams({
      agent_identity_id: this.options.identityId,
      limit: String(options?.limit ?? DEFAULT_LIST_LIMIT),
    });
    const result = await this.request("GET", `${this.apiRoot()}/messages?${params.toString()}`);
    if (!Array.isArray(result)) return [];
    return result.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null).map(toMessage);
  }

  async send(to: string, text: string): Promise<SendImessageResult> {
    const url = `${this.apiRoot()}/messages?agent_identity_id=${encodeURIComponent(this.options.identityId)}`;
    const result = (await this.request("POST", url, { to, text })) as { message?: { status?: string; id?: string } };
    return { status: result.message?.status ?? "pending", id: result.message?.id };
  }
}

/** Deterministic stand-in for tests — records every send, never touches the network. */
export class FakeImessageClient implements ImessageClient {
  readonly sent: { to: string; text: string }[] = [];
  constructor(private readonly inbox: readonly ImessageMessage[] = []) {}

  async listMessages(): Promise<readonly ImessageMessage[]> {
    return this.inbox;
  }

  async send(to: string, text: string): Promise<SendImessageResult> {
    this.sent.push({ to, text });
    return { status: "pending", id: `fake-${this.sent.length}` };
  }
}

/**
 * The real client when every required value is configured, otherwise
 * `undefined` — never a half-configured client, same pattern as
 * `createSmsClientFromEnv` and `createInkboxClientFromEnv`.
 */
export function createImessageClientFromEnv(): ImessageClient | undefined {
  const apiKey = process.env["INKBOX_API_KEY"];
  const identityId = process.env["INKBOX_IDENTITY_ID"];
  if (!apiKey || !identityId) return undefined;

  return new InkboxImessageClient({
    apiKey,
    identityId,
    baseUrl: process.env["INKBOX_API_BASE_URL"],
  });
}
