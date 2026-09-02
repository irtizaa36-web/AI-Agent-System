import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "../../store/run-store";
import type { DraftEmail, EmailAddress } from "./client";

export interface SaveDraftInput {
  readonly to: readonly EmailAddress[];
  readonly subject: string;
  readonly body: string;
  readonly bcc?: readonly EmailAddress[];
  readonly threadId?: string;
  readonly draftId?: string;
}

/**
 * Where a Draft's own revision counter lives. Inkbox's real Mail API has no
 * draft object of its own (see mail/resources/messages.ts in the Inkbox SDK
 * — sending composes and delivers in one call); "draft" is a concept this
 * project owns on its own side of the InkboxClient port, same as it already
 * was for FakeInkboxClient. A DraftStore is what RealInkboxClient uses to
 * keep that concept working the same way against the real API.
 */
export interface DraftStore {
  save(input: SaveDraftInput): Promise<DraftEmail>;
  get(draftId: string): Promise<DraftEmail | undefined>;
}

interface StoredDraft extends DraftEmail {
  readonly revisionNumber: number;
}

function nextDraft(id: string, priorRevisionNumber: number, input: SaveDraftInput): StoredDraft {
  const revisionNumber = priorRevisionNumber + 1;
  return {
    id,
    revision: `rev-${revisionNumber}`,
    revisionNumber,
    to: input.to,
    bcc: input.bcc ?? [],
    subject: input.subject,
    body: input.body,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    updatedAt: new Date().toISOString(),
  };
}

function toDraftEmail(stored: StoredDraft): DraftEmail {
  const { revisionNumber: _revisionNumber, ...draft } = stored;
  return draft;
}

/** In-memory only — used by tests and as a safe default when no on-disk location is configured. */
export class InMemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<string, StoredDraft>();

  async save(input: SaveDraftInput): Promise<DraftEmail> {
    const id = input.draftId ?? `draft-${randomUUID()}`;
    const draft = nextDraft(id, this.drafts.get(id)?.revisionNumber ?? 0, input);
    this.drafts.set(id, draft);
    return toDraftEmail(draft);
  }

  async get(draftId: string): Promise<DraftEmail | undefined> {
    const draft = this.drafts.get(draftId);
    return draft ? toDraftEmail(draft) : undefined;
  }
}

/**
 * Persists each draft as one JSON file, so the draft/review/approve/send CLI
 * flow survives across separate CLI process invocations against a real
 * mailbox — the same reason Runs are persisted via JsonFileRunStore rather
 * than kept only in memory.
 */
export class JsonFileDraftStore implements DraftStore {
  constructor(private readonly dir: string) {}

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async save(input: SaveDraftInput): Promise<DraftEmail> {
    await mkdir(this.dir, { recursive: true });
    const id = input.draftId ?? `draft-${randomUUID()}`;
    const prior = await this.readStored(id);
    const draft = nextDraft(id, prior?.revisionNumber ?? 0, input);
    await writeFile(this.pathFor(id), JSON.stringify(draft, null, 2), "utf-8");
    return toDraftEmail(draft);
  }

  async get(draftId: string): Promise<DraftEmail | undefined> {
    const stored = await this.readStored(draftId);
    return stored ? toDraftEmail(stored) : undefined;
  }

  private async readStored(id: string): Promise<StoredDraft | undefined> {
    try {
      const raw = await readFile(this.pathFor(id), "utf-8");
      return JSON.parse(raw) as StoredDraft;
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      throw error;
    }
  }
}
