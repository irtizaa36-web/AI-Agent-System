import type { DraftEmail, EmailAddress, EmailMessage, EmailThread, ForwardResult, InkboxClient, SendResult } from "./client";
import { InMemoryDraftStore, type DraftStore } from "./draft-store";

/**
 * The real Inkbox Mail API, called directly with `fetch` — no `@inkbox/sdk`
 * runtime dependency (ADR 0002: this project stays at zero runtime deps,
 * the same reason providers/anthropic.ts calls Anthropic's API directly
 * instead of depending on its SDK). The request/response shapes and the
 * `X-Service-Token` auth header below are taken from Inkbox's own published
 * TypeScript SDK (github.com/VectorlyApp/inkbox, typescript/src/_http.ts and
 * typescript/src/mail/*), not guessed.
 */
const DEFAULT_BASE_URL = "https://api.inkbox.ai";
const API_ROOT_SUFFIX = "/api/v1/mail";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_LIMIT = 50;

export class InkboxAPIError extends Error {
  readonly statusCode: number;
  readonly detail: string;

  constructor(statusCode: number, detail: string) {
    super(`Inkbox API error (HTTP ${statusCode}): ${detail}`);
    this.name = "InkboxAPIError";
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

// ---- raw wire shapes (snake_case), matching Inkbox's real Mail API ----

interface RawMessage {
  readonly id: string;
  readonly thread_id: string | null;
  readonly message_id?: string;
  readonly from_address: string;
  readonly to_addresses: readonly string[];
  readonly bcc_addresses?: readonly string[] | null;
  readonly subject: string | null;
  readonly snippet?: string | null;
  readonly created_at: string;
  readonly body_text?: string | null;
  readonly body_html?: string | null;
}

interface RawThread {
  readonly id: string;
  readonly subject: string | null;
  readonly messages?: readonly RawMessage[];
}

interface RawCursorPage<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function bodyFrom(raw: Pick<RawMessage, "body_text" | "body_html" | "snippet">): string {
  if (raw.body_text) return raw.body_text;
  if (raw.body_html) return stripHtml(raw.body_html);
  return raw.snippet ?? "";
}

/** Exported for direct unit testing — pure, no network. */
export function parseRawMessage(raw: RawMessage): EmailMessage {
  return {
    id: raw.id,
    threadId: raw.thread_id ?? raw.id,
    from: { address: raw.from_address },
    to: raw.to_addresses.map((address) => ({ address })),
    ...(raw.bcc_addresses ? { bcc: raw.bcc_addresses.map((address) => ({ address })) } : {}),
    subject: raw.subject ?? "",
    body: bodyFrom(raw),
    receivedAt: raw.created_at,
  };
}

/** Exported for direct unit testing — pure, no network. */
export function parseRawThread(raw: RawThread, messages: readonly EmailMessage[]): EmailThread {
  return { id: raw.id, subject: raw.subject ?? "", messages };
}

type QueryParams = Record<string, string | number | undefined>;

class InkboxHttp {
  private readonly apiRoot: string;

  constructor(
    private readonly apiKey: string,
    baseUrl: string | undefined,
    private readonly timeoutMs: number,
  ) {
    this.apiRoot = `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")}${API_ROOT_SUFFIX}`;
  }

  async get<T>(path: string, params?: QueryParams): Promise<T> {
    return this.request<T>("GET", path, { params });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  private async request<T>(method: string, path: string, opts: { params?: QueryParams; body?: unknown }): Promise<T> {
    let url = `${this.apiRoot}${path}`;
    if (opts.params) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(opts.params)) {
        if (value !== undefined) qs.set(key, String(value));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    // Never logged, never included in any error message below — only ever sent as this one request header.
    const headers: Record<string, string> = { "X-Service-Token": this.apiKey, Accept: "application/json" };
    let bodyStr: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr = JSON.stringify(opts.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { method, headers, body: bodyStr, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let detail: string;
      try {
        const err = (await response.json()) as { detail?: string };
        detail = err.detail ?? response.statusText;
      } catch {
        detail = response.statusText;
      }
      throw new InkboxAPIError(response.status, detail);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}

export interface RealInkboxClientOptions {
  /** Your Inkbox API key. Read from INKBOX_API_KEY by createInkboxClientFromEnv — never hard-code this. */
  readonly apiKey: string;
  /** The mailbox this client acts as, e.g. "toozy@inkboxmail.com". Read from INKBOX_MAILBOX_ADDRESS. */
  readonly mailboxAddress: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Where draft state (a concept this project owns, not Inkbox) is kept. Defaults to in-memory. */
  readonly draftStore?: DraftStore;
}

/**
 * The production InkboxClient, backed by Inkbox's real Mail API. Reads no
 * environment variables itself — see createInkboxClientFromEnv for that —
 * so constructing one always requires its caller to have already resolved
 * real credentials from the environment.
 */
export function createRealInkboxClient(options: RealInkboxClientOptions): InkboxClient {
  const http = new InkboxHttp(options.apiKey, options.baseUrl, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const draftStore = options.draftStore ?? new InMemoryDraftStore();
  const mailboxAddress = options.mailboxAddress;
  const mailboxPath = `/mailboxes/${encodeURIComponent(mailboxAddress)}`;

  async function fetchMessageDetail(messageId: string): Promise<EmailMessage | undefined> {
    try {
      const raw = await http.get<RawMessage>(`${mailboxPath}/messages/${encodeURIComponent(messageId)}`);
      return raw ? parseRawMessage(raw) : undefined;
    } catch (error) {
      if (error instanceof InkboxAPIError && error.statusCode === 404) return undefined;
      throw error;
    }
  }

  return {
    mailboxAddress,

    async searchMail(query?: string): Promise<readonly EmailMessage[]> {
      const page = query
        ? await http.get<RawCursorPage<RawMessage>>(`${mailboxPath}/search`, { q: query, limit: DEFAULT_PAGE_LIMIT })
        : await http.get<RawCursorPage<RawMessage>>(`${mailboxPath}/messages`, { limit: DEFAULT_PAGE_LIMIT });
      return page.items.map(parseRawMessage);
    },

    async readThread(threadId: string): Promise<EmailThread | undefined> {
      let raw: RawThread;
      try {
        raw = await http.get<RawThread>(`${mailboxPath}/threads/${encodeURIComponent(threadId)}`);
      } catch (error) {
        if (error instanceof InkboxAPIError && error.statusCode === 404) return undefined;
        throw error;
      }
      // The thread endpoint returns snippet-level messages only; enrich each
      // with its full body so a resumed Run sees the actual reply text.
      const messages = await Promise.all(
        (raw.messages ?? []).map(async (m) => (await fetchMessageDetail(m.id)) ?? parseRawMessage(m)),
      );
      return parseRawThread(raw, messages);
    },

    async getMessage(messageId: string): Promise<EmailMessage | undefined> {
      return fetchMessageDetail(messageId);
    },

    async saveDraft(input): Promise<DraftEmail> {
      return draftStore.save(input);
    },

    async getDraft(draftId: string): Promise<DraftEmail | undefined> {
      return draftStore.get(draftId);
    },

    async send(input: { readonly draftId: string; readonly revision: string }): Promise<SendResult> {
      const draft = await draftStore.get(input.draftId);
      if (!draft) {
        throw new Error(`No draft "${input.draftId}" to send`);
      }
      if (draft.revision !== input.revision) {
        throw new Error(
          `Draft "${input.draftId}" has changed since this send was prepared ` +
            `(current revision ${draft.revision}, expected ${input.revision})`,
        );
      }

      const recipients: Record<string, readonly string[]> = { to: draft.to.map((a) => a.address) };
      if (draft.bcc && draft.bcc.length > 0) recipients["bcc"] = draft.bcc.map((a) => a.address);

      const raw = await http.post<RawMessage>(`${mailboxPath}/messages`, {
        recipients,
        subject: draft.subject,
        body_text: draft.body,
      });
      const sent = parseRawMessage(raw);
      return { messageId: sent.id, threadId: sent.threadId, to: draft.to, bcc: draft.bcc ?? [], sentAt: sent.receivedAt };
    },

    async forward(messageId: string, to: EmailAddress): Promise<ForwardResult> {
      const original = await fetchMessageDetail(messageId);
      if (!original) {
        return { status: "skipped", reason: `message "${messageId}" not found` };
      }
      const subject = /^fwd:/i.test(original.subject) ? original.subject : `Fwd: ${original.subject}`;
      const body = [
        "---------- Forwarded message ----------",
        `From: ${original.from.address}`,
        `Date: ${original.receivedAt}`,
        `Subject: ${original.subject}`,
        `To: ${original.to.map((a) => a.address).join(", ")}`,
        "",
        original.body,
      ].join("\n");

      await http.post<RawMessage>(`${mailboxPath}/messages`, { recipients: { to: [to.address] }, subject, body_text: body });
      return { status: "forwarded" };
    },
  };
}

export interface CreateInkboxClientFromEnvOptions {
  readonly draftStore?: DraftStore;
}

/**
 * Builds a real InkboxClient strictly from environment variables —
 * INKBOX_API_KEY and INKBOX_MAILBOX_ADDRESS. Returns undefined (never
 * throws) when either is missing, so callers can cleanly fall back to the
 * fake client instead of accidentally half-configuring a real one.
 */
export function createInkboxClientFromEnv(options: CreateInkboxClientFromEnvOptions = {}): InkboxClient | undefined {
  const apiKey = process.env["INKBOX_API_KEY"];
  const mailboxAddress = process.env["INKBOX_MAILBOX_ADDRESS"];
  if (!apiKey || !mailboxAddress) return undefined;

  return createRealInkboxClient({
    apiKey,
    mailboxAddress,
    baseUrl: process.env["INKBOX_API_BASE_URL"],
    draftStore: options.draftStore,
  });
}
