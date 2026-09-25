import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SETTLEMENT_STATUSES, VERDICTS, type TrackerDocument } from "./types";

/**
 * Where the tracker document lives. Storage only loads and saves one
 * document; every rule lives once, in SettlementTracker, instead of being
 * duplicated across an in-memory and a file-backed store.
 */
export interface TrackerStorage {
  /** undefined only when nothing has been saved yet. */
  load(): Promise<TrackerDocument | undefined>;
  save(doc: TrackerDocument): Promise<void>;
}

export class InMemoryTrackerStorage implements TrackerStorage {
  private json: string | undefined;

  constructor(initial?: TrackerDocument) {
    if (initial) this.json = JSON.stringify(initial);
  }
  async load(): Promise<TrackerDocument | undefined> {
    return this.json === undefined ? undefined : validateDocument(JSON.parse(this.json), "in-memory tracker");
  }
  async save(doc: TrackerDocument): Promise<void> {
    this.json = JSON.stringify(doc);
  }
}

/**
 * One JSON file under .orchestrator/ (gitignored): the tracker holds personal
 * data such as confirmation numbers and stays on the owner's machine. Written
 * atomically. A file that exists but can't be read is an error, never a
 * silent reset — losing the tracker would lose confirmation numbers.
 */
export class JsonFileTrackerStorage implements TrackerStorage {
  constructor(private readonly path: string) {}

  async load(): Promise<TrackerDocument | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Settlement tracker ${this.path} is not valid JSON (${(error as Error).message}). Fix or restore it; it was not overwritten.`);
    }
    return validateDocument(parsed, this.path);
  }

  async save(doc: TrackerDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
    await rename(tmp, this.path);
  }
}

function fail(where: string, problem: string): never {
  throw new Error(`Settlement tracker ${where} is malformed: ${problem}. It was not overwritten.`);
}

export function validateDocument(value: unknown, where: string): TrackerDocument {
  if (typeof value !== "object" || value === null) fail(where, "not an object");
  const doc = value as Record<string, unknown>;
  if (doc["version"] !== 1) fail(where, `unsupported version ${String(doc["version"])}`);
  for (const key of ["settlements", "doNotResearch", "inbox", "seenKeys", "nudges"]) {
    if (!Array.isArray(doc[key])) fail(where, `"${key}" must be a list`);
  }
  for (const s of doc["settlements"] as Record<string, unknown>[]) {
    if (typeof s["id"] !== "string" || typeof s["name"] !== "string") fail(where, "a settlement is missing its id or name");
    if (!SETTLEMENT_STATUSES.includes(s["status"] as never)) fail(where, `settlement ${String(s["id"])} has unknown status ${String(s["status"])}`);
    const eligibility = s["eligibility"] as Record<string, unknown> | undefined;
    if (!eligibility || !VERDICTS.includes(eligibility["verdict"] as never)) fail(where, `settlement ${String(s["id"])} has no valid eligibility verdict`);
    for (const key of ["aliases", "domains", "criteria", "deadlineConflicts", "history", "actions"]) {
      if (!Array.isArray(s[key])) fail(where, `settlement ${String(s["id"])} "${key}" must be a list`);
    }
  }
  return value as TrackerDocument;
}
