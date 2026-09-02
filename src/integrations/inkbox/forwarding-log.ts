export interface ForwardingRecord {
  readonly messageId: string;
  readonly forwardedTo: string;
  readonly status: "forwarded" | "failed" | "skipped";
  readonly reason?: string;
  readonly occurredAt: string;
}

/**
 * Tracks which inbound messages have already been forwarded to the owner,
 * so a message is never forwarded twice and a forwarding failure is
 * recorded on its own — never as part of the original message's or Run's
 * result. In-memory only for now: the whole Inkbox subsystem is fake/demo
 * until a real client exists (see client.ts), so a persistent variant isn't
 * justified yet either.
 */
export interface ForwardingLog {
  hasForwarded(messageId: string): Promise<boolean>;
  record(entry: ForwardingRecord): Promise<void>;
  list(): Promise<readonly ForwardingRecord[]>;
}

export class InMemoryForwardingLog implements ForwardingLog {
  private readonly records = new Map<string, ForwardingRecord>();

  async hasForwarded(messageId: string): Promise<boolean> {
    return this.records.get(messageId)?.status === "forwarded";
  }

  async record(entry: ForwardingRecord): Promise<void> {
    this.records.set(entry.messageId, entry);
  }

  async list(): Promise<readonly ForwardingRecord[]> {
    return [...this.records.values()];
  }
}
