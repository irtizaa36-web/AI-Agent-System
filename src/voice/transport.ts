import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * How an approved reply leaves this project (ADR 0023). A reply to a
 * forwarded Google Voice text goes out as an SMS from the Voice number when
 * it's sent as a Gmail reply to that email's reply address. This project
 * holds no Gmail credentials, so the real transport hands the approved reply
 * to an outbox. The agent session's Gmail connector transmits it, and
 * `voice mark-sent` records that it went.
 */
export interface OutboundReply {
  readonly draftId: string;
  readonly threadId: string;
  readonly inReplyToMessageId: string;
  readonly to: string;
  readonly body: string;
}

export interface TransportResult {
  /** true when the SMS has actually gone out; false when it was handed off for transmission. */
  readonly delivered: boolean;
  readonly reference: string;
}

export interface VoiceReplyTransport {
  send(reply: OutboundReply): Promise<TransportResult>;
}

/** Records what would have been sent. Tests use it to prove nothing is sent without approval. */
export class FakeVoiceReplyTransport implements VoiceReplyTransport {
  readonly sent: OutboundReply[] = [];
  failNext?: Error;

  async send(reply: OutboundReply): Promise<TransportResult> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    this.sent.push(reply);
    return { delivered: true, reference: `fake-${this.sent.length}` };
  }
}

/**
 * Writes the released reply to .orchestrator/voice/outbox/<draftId>.json
 * (gitignored). The agent may transmit only files that appear here, and
 * only by replying in the named Gmail thread to the named address.
 */
export class OutboxVoiceReplyTransport implements VoiceReplyTransport {
  constructor(private readonly dir: string) {}

  async send(reply: OutboundReply): Promise<TransportResult> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, `${reply.draftId}.json`);
    await writeFile(path, `${JSON.stringify({ ...reply, releasedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return { delivered: false, reference: path };
  }
}
