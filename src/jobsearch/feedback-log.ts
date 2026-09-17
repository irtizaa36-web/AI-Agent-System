import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "../store/run-store";

/** One field the classifier actually changed on a past turn — the durable form of feedback.ts's PatchEntry, kept for conversation history rather than just the field name, so a later message like "make it higher" has something to resolve "it" against. */
export interface AppliedChangeRecord {
  readonly field: string;
  readonly value: unknown;
}

export interface FeedbackRecord {
  readonly messageId: string;
  readonly fromAddress: string;
  readonly processedAt: string;
  readonly appliedFields: readonly string[];
  readonly hadQuestion: boolean;
  readonly replied: boolean;
  /**
   * Her actual message and what we said back, plus the changes with their
   * values (appliedFields above only has names). Optional because every
   * record written before this field existed lacks it — conversation-history
   * building (feedback.ts's buildConversationHistory) must degrade cleanly
   * when reading an old record, not crash or invent the missing text.
   */
  readonly messageText?: string;
  readonly appliedChanges?: readonly AppliedChangeRecord[];
  readonly replyBody?: string;
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
