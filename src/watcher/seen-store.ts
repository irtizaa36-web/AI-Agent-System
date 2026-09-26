import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "../store/run-store";

/**
 * Tracks which (branch, path, sha) brief files the watcher has already
 * picked up, so a poll never re-checks-out and re-logs the same brief —
 * and so editing a brief file (a new content sha) reads as a new pickup,
 * not a repeat. Same seam as ForwardingLog: in-memory for tests, one JSON
 * file per key on disk for the real, long-running watcher process.
 */
export interface SeenBriefStore {
  has(key: string): Promise<boolean>;
  markSeen(key: string): Promise<void>;
}

export class InMemorySeenBriefStore implements SeenBriefStore {
  private readonly seen = new Set<string>();

  async has(key: string): Promise<boolean> {
    return this.seen.has(key);
  }

  async markSeen(key: string): Promise<void> {
    this.seen.add(key);
  }
}

function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200);
}

export class JsonFileSeenBriefStore implements SeenBriefStore {
  constructor(private readonly dir: string) {}

  private pathFor(key: string): string {
    return join(this.dir, `${sanitizeForFilename(key)}.json`);
  }

  async has(key: string): Promise<boolean> {
    try {
      await readFile(this.pathFor(key), "utf-8");
      return true;
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  }

  async markSeen(key: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathFor(key), JSON.stringify({ key, seenAt: new Date().toISOString() }, null, 2), "utf-8");
  }
}

/** The stable dedupe key for one observation of a brief file's content. */
export function briefSeenKey(branch: string, path: string, sha: string): string {
  return `${branch}::${path}::${sha}`;
}
