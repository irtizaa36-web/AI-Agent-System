import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "../../store/run-store";

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
 * result.
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

/** `messageId` arrives from an externally-supplied webhook payload — sanitized before ever touching a filename. */
function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

/**
 * Persists forwarding decisions to disk, one JSON file per message id, so a
 * restart of the long-running webhook receiver can never re-forward a
 * message it already forwarded — the real, production-facing counterpart to
 * InMemoryForwardingLog (which stays in-memory-only for tests and the
 * CLI's own one-shot `check-replies` invocation).
 */
export class JsonFileForwardingLog implements ForwardingLog {
  constructor(private readonly dir: string) {}

  private pathFor(messageId: string): string {
    return join(this.dir, `${sanitizeForFilename(messageId)}.json`);
  }

  async hasForwarded(messageId: string): Promise<boolean> {
    const record = await this.read(messageId);
    return record?.status === "forwarded";
  }

  async record(entry: ForwardingRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathFor(entry.messageId), JSON.stringify(entry, null, 2), "utf-8");
  }

  async list(): Promise<readonly ForwardingRecord[]> {
    try {
      const files = await readdir(this.dir);
      return await Promise.all(
        files.filter((f) => f.endsWith(".json")).map(async (f) => JSON.parse(await readFile(join(this.dir, f), "utf-8")) as ForwardingRecord),
      );
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }

  private async read(messageId: string): Promise<ForwardingRecord | undefined> {
    try {
      const raw = await readFile(this.pathFor(messageId), "utf-8");
      return JSON.parse(raw) as ForwardingRecord;
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      throw error;
    }
  }
}
