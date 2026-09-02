/**
 * The port this project depends on for Inkbox mailbox access. No real
 * implementation exists yet (see FakeInkboxClient and README notes in
 * config/load.ts) — there is no documented, standalone-callable Inkbox API
 * to build a real adapter against from outside a Claude session yet. This
 * interface exists so Tools, tests, and a future real client all agree on
 * one shape, per the same Provider/Tool seam pattern (ADR 0001).
 */
export interface EmailAddress {
  readonly address: string;
  readonly name?: string;
}

/**
 * Validates a full array of `{ address: string }` entries, not just that
 * the array itself exists — a Tool's own input guard (isSaveDraftInput,
 * isSendEmailInput) must catch a malformed entry (e.g. a model calling a
 * Tool with a name but no known email address) with a clear error, rather
 * than letting `undefined.toLowerCase()` crash deep inside
 * computeOutboundBcc/sameAddresses.
 */
export function isEmailAddressArray(value: unknown): value is readonly EmailAddress[] {
  return Array.isArray(value) && value.every((v) => typeof v === "object" && v !== null && typeof (v as { address?: unknown }).address === "string" && (v as { address: string }).address.length > 0);
}

export interface EmailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly from: EmailAddress;
  readonly to: readonly EmailAddress[];
  readonly bcc?: readonly EmailAddress[];
  readonly subject: string;
  readonly body: string;
  readonly receivedAt: string;
  readonly attachments?: readonly string[];
}

export interface EmailThread {
  readonly id: string;
  readonly subject: string;
  readonly messages: readonly EmailMessage[];
}

export interface DraftEmail {
  readonly id: string;
  readonly revision: string;
  readonly to: readonly EmailAddress[];
  readonly bcc?: readonly EmailAddress[];
  readonly subject: string;
  readonly body: string;
  readonly threadId?: string;
  readonly updatedAt: string;
}

export interface SendResult {
  readonly messageId: string;
  readonly threadId: string;
  readonly to: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly sentAt: string;
}

export interface ForwardResult {
  readonly status: "forwarded" | "skipped";
  readonly reason?: string;
}

export interface InkboxClient {
  readonly mailboxAddress: string;

  /** Lists/searches the mailbox's inbound mail. Read-only. */
  searchMail(query?: string): Promise<readonly EmailMessage[]>;

  /** Reads a complete thread by id. Read-only. */
  readThread(threadId: string): Promise<EmailThread | undefined>;

  /** Reads one message by id. Read-only. */
  getMessage(messageId: string): Promise<EmailMessage | undefined>;

  /** Saves (or updates) a draft. Safe — never delivers anything. */
  saveDraft(input: {
    readonly to: readonly EmailAddress[];
    readonly subject: string;
    readonly body: string;
    readonly bcc?: readonly EmailAddress[];
    readonly threadId?: string;
    readonly draftId?: string;
  }): Promise<DraftEmail>;

  /** Reads back an exact draft by id, including its current revision. Read-only. */
  getDraft(draftId: string): Promise<DraftEmail | undefined>;

  /** Consequential: actually delivers the draft. Only ever called after exact-match approval. */
  send(input: { readonly draftId: string; readonly revision: string }): Promise<SendResult>;

  /**
   * Forwards one inbound message's exact content to `to`, without exposing
   * `to` to the original sender or recipients. A distinct outbound action
   * from `send`, tracked separately (see ForwardingLog) so a forwarding
   * failure never taints the record of the original inbound message.
   */
  forward(messageId: string, to: EmailAddress): Promise<ForwardResult>;
}
