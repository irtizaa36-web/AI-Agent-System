import type { DraftEmail, EmailAddress, EmailMessage, EmailThread, ForwardResult, InkboxClient, SendResult } from "./client";

/**
 * A deterministic, in-memory stand-in for a real Inkbox client. Tests and
 * the CLI's default wiring use only this — never a real mailbox, real
 * credentials, or real network access (no real client exists yet; see
 * client.ts).
 */
export class FakeInkboxClient implements InkboxClient {
  readonly mailboxAddress: string;
  private readonly messages = new Map<string, EmailMessage>();
  private readonly threads = new Map<string, EmailThread>();
  private readonly drafts = new Map<string, DraftEmail>();
  private readonly draftRevisions = new Map<string, number>();
  private draftCounter = 0;
  private messageCounter = 0;

  constructor(mailboxAddress = "agent@example.test", seedMessages: readonly EmailMessage[] = []) {
    this.mailboxAddress = mailboxAddress;
    for (const message of seedMessages) this.receiveInbound(message);
  }

  /** Test/demo helper: simulate a new inbound message arriving, with no real network involved. */
  receiveInbound(message: EmailMessage): void {
    this.messages.set(message.id, message);
    const thread = this.threads.get(message.threadId) ?? { id: message.threadId, subject: message.subject, messages: [] };
    this.threads.set(message.threadId, { ...thread, messages: [...thread.messages, message] });
  }

  async searchMail(query?: string): Promise<readonly EmailMessage[]> {
    const all = [...this.messages.values()];
    if (!query) return all;
    const needle = query.toLowerCase();
    return all.filter(
      (m) =>
        m.subject.toLowerCase().includes(needle) ||
        m.body.toLowerCase().includes(needle) ||
        m.from.address.toLowerCase().includes(needle),
    );
  }

  async readThread(threadId: string): Promise<EmailThread | undefined> {
    return this.threads.get(threadId);
  }

  async getMessage(messageId: string): Promise<EmailMessage | undefined> {
    return this.messages.get(messageId);
  }

  async saveDraft(input: {
    readonly to: DraftEmail["to"];
    readonly subject: string;
    readonly body: string;
    readonly bcc?: DraftEmail["bcc"];
    readonly threadId?: string;
    readonly draftId?: string;
  }): Promise<DraftEmail> {
    const id = input.draftId ?? `draft-${++this.draftCounter}`;
    const revisionNumber = (this.draftRevisions.get(id) ?? 0) + 1;
    this.draftRevisions.set(id, revisionNumber);

    const draft: DraftEmail = {
      id,
      revision: `rev-${revisionNumber}`,
      to: input.to,
      bcc: input.bcc ?? [],
      subject: input.subject,
      body: input.body,
      threadId: input.threadId,
      updatedAt: new Date().toISOString(),
    };
    this.drafts.set(id, draft);
    return draft;
  }

  async getDraft(draftId: string): Promise<DraftEmail | undefined> {
    return this.drafts.get(draftId);
  }

  async send(input: { readonly draftId: string; readonly revision: string }): Promise<SendResult> {
    const draft = this.drafts.get(input.draftId);
    if (!draft) {
      throw new Error(`No draft "${input.draftId}" to send`);
    }
    if (draft.revision !== input.revision) {
      throw new Error(
        `Draft "${input.draftId}" has changed since this send was prepared ` +
          `(current revision ${draft.revision}, expected ${input.revision})`,
      );
    }

    const threadId = draft.threadId ?? `thread-${draft.id}`;
    const messageId = `sent-${++this.messageCounter}`;
    const sentAt = new Date().toISOString();
    const sentMessage: EmailMessage = {
      id: messageId,
      threadId,
      from: { address: this.mailboxAddress },
      to: draft.to,
      bcc: draft.bcc,
      subject: draft.subject,
      body: draft.body,
      receivedAt: sentAt,
    };
    this.receiveInbound(sentMessage);

    return { messageId, threadId, to: draft.to, bcc: draft.bcc ?? [], sentAt };
  }

  async forward(messageId: string, _to: EmailAddress): Promise<ForwardResult> {
    const message = this.messages.get(messageId);
    if (!message) {
      return { status: "skipped", reason: `message "${messageId}" not found` };
    }
    return { status: "forwarded" };
  }
}
