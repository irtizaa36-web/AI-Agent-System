import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "../../store/run-store";

/**
 * The message-lifecycle outcomes this project records from Inkbox webhook
 * events, distinct from ForwardingLog: this tracks what happened to a
 * message itself (did it send, deliver, bounce, fail; was an inbound
 * message's forward confirmed by Inkbox), never conflating that with
 * whether *our own* forward-to-owner attempt succeeded — that stays in
 * ForwardingLog so a forwarding failure never reads as the original
 * message having failed.
 */
export type MessageLifecycleEvent = "sent" | "delivered" | "bounced" | "failed" | "forwarded_confirmation";

export interface MessageEventRecord {
  readonly messageId: string;
  readonly event: MessageLifecycleEvent;
  readonly detail?: string;
  readonly occurredAt: string;
}

export interface MessageEventLog {
  record(entry: MessageEventRecord): Promise<void>;
  list(): Promise<readonly MessageEventRecord[]>;
}

export class InMemoryMessageEventLog implements MessageEventLog {
  private readonly records: MessageEventRecord[] = [];

  async record(entry: MessageEventRecord): Promise<void> {
    this.records.push(entry);
  }

  async list(): Promise<readonly MessageEventRecord[]> {
    return [...this.records];
  }
}

/** `messageId` arrives from an externally-supplied webhook payload — sanitized before ever touching a filename. */
function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

/**
 * Persists each recorded event as its own JSON file, so the audit trail
 * survives restarts of the long-running webhook receiver process. One file
 * per event occurrence (not per message) — a message id can legitimately
 * accumulate several distinct lifecycle events (e.g. sent, then delivered).
 */
export class JsonFileMessageEventLog implements MessageEventLog {
  constructor(private readonly dir: string) {}

  async record(entry: MessageEventRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const filename = `${sanitizeForFilename(entry.messageId)}__${entry.event}__${randomUUID()}.json`;
    await writeFile(join(this.dir, filename), JSON.stringify(entry, null, 2), "utf-8");
  }

  async list(): Promise<readonly MessageEventRecord[]> {
    try {
      const files = await readdir(this.dir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      return await Promise.all(
        jsonFiles.map(async (file) => JSON.parse(await readFile(join(this.dir, file), "utf-8")) as MessageEventRecord),
      );
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }
}
