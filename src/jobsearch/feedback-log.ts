import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "../store/run-store";

export interface FeedbackRecord {
  readonly messageId: string;
  readonly fromAddress: string;
  readonly processedAt: string;
  readonly appliedFields: readonly string[];
  readonly hadQuestion: boolean;
  readonly replied: boolean;
}

/**
 * Tracks which inbound messages have already been run through the feedback
 * loop (feedback.ts), so a poll (jobs check-feedback) that re-reads the
 * whole mailbox never reclassifies — and never re-applies, or re-replies
 * to — a message it already handled. Same shape as ForwardingLog on
 * purpose (see forwarding-log.ts) — one JSON file per message id, scoped
 * under this profile's own data directory rather than the shared Inkbox
 * integration folder, because which messages have been treated as
 * feedback is a job-search-pipeline concern, not a mailbox-wide one.
 */
export interface FeedbackLog {
  hasProcessed(messageId: string): Promise<boolean>;
  record(entry: FeedbackRecord): Promise<void>;
  list(): Promise<readonly FeedbackRecord[]>;
}

export class InMemoryFeedbackLog implements FeedbackLog {
  private readonly records = new Map<string, FeedbackRecord>();

  async hasProcessed(messageId: string): Promise<boolean> {
    return this.records.has(messageId);
  }

  async record(entry: FeedbackRecord): Promise<void> {
    this.records.set(entry.messageId, entry);
  }

  async list(): Promise<readonly FeedbackRecord[]> {
    return [...this.records.values()];
  }
}

function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

export class JsonFileFeedbackLog implements FeedbackLog {
  constructor(private readonly dir: string) {}

  private pathFor(messageId: string): string {
    return join(this.dir, `${sanitizeForFilename(messageId)}.json`);
  }

  async hasProcessed(messageId: string): Promise<boolean> {
    try {
      await readFile(this.pathFor(messageId), "utf-8");
      return true;
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  }

  async record(entry: FeedbackRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathFor(entry.messageId), JSON.stringify(entry, null, 2), "utf-8");
  }

  async list(): Promise<readonly FeedbackRecord[]> {
    try {
      const files = await readdir(this.dir);
      return await Promise.all(
        files.filter((f) => f.endsWith(".json")).map(async (f) => JSON.parse(await readFile(join(this.dir, f), "utf-8")) as FeedbackRecord),
      );
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }
}
