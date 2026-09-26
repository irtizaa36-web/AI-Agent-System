import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { redactCodes } from "./redact";
import { emptyVoiceState, type VoiceStateDocument } from "./types";

/**
 * Loads and saves the one Voice state document. Every rule lives in the
 * broker and the drafter, not here, so the in-memory store used by tests and
 * the file store can't drift apart (the settlements storage shape, ADR 0022).
 */
export interface VoiceStateStore {
  load(): Promise<VoiceStateDocument>;
  /** Read-modify-write. The updater may throw to abort without saving. */
  update(updater: (doc: VoiceStateDocument) => VoiceStateDocument): Promise<VoiceStateDocument>;
}

/**
 * Last line of defence for "no code value in any file": before anything is
 * saved, every free-text field an alert carries is re-redacted. The broker
 * already redacts, so this only matters if a future change forgets to.
 */
function scrub(doc: VoiceStateDocument): VoiceStateDocument {
  return {
    ...doc,
    alerts: doc.alerts.map((a) => ({ ...a, detail: redactCodes(a.detail), redactedText: redactCodes(a.redactedText) })),
  };
}

function validate(value: unknown, where: string): VoiceStateDocument {
  const doc = value as Partial<VoiceStateDocument> | null;
  if (
    !doc ||
    doc.version !== 1 ||
    !Array.isArray(doc.pending) ||
    !Array.isArray(doc.alerts) ||
    !Array.isArray(doc.listings) ||
    !Array.isArray(doc.drafts) ||
    !Array.isArray(doc.processedMessageIds) ||
    typeof doc.threadListings !== "object" ||
    doc.threadListings === null
  )
    throw new Error(`${where} is not a valid Voice state document (version 1).`);
  return doc as VoiceStateDocument;
}

export class InMemoryVoiceStateStore implements VoiceStateStore {
  private json: string;

  constructor(initial: VoiceStateDocument = emptyVoiceState()) {
    this.json = JSON.stringify(initial);
  }
  async load(): Promise<VoiceStateDocument> {
    return validate(JSON.parse(this.json), "in-memory Voice state");
  }
  async update(updater: (doc: VoiceStateDocument) => VoiceStateDocument): Promise<VoiceStateDocument> {
    const next = scrub(updater(await this.load()));
    this.json = JSON.stringify(next);
    return next;
  }
  /** Tests read the raw serialized state to prove no code value was written. */
  raw(): string {
    return this.json;
  }
}

/**
 * One JSON file under .orchestrator/voice/ (gitignored). It holds phone
 * numbers and message text, so it stays on the owner's machine. Written
 * atomically. A file that exists but can't be parsed is an error, never a
 * silent reset, because resetting would reopen consumed verifications and
 * drop alerts.
 */
export class JsonFileVoiceStateStore implements VoiceStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<VoiceStateDocument> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyVoiceState();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${this.path} exists but is not valid JSON. Fix or move it; it was not overwritten.`);
    }
    return validate(parsed, this.path);
  }

  async update(updater: (doc: VoiceStateDocument) => VoiceStateDocument): Promise<VoiceStateDocument> {
    const next = scrub(updater(await this.load()));
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
    return next;
  }
}
