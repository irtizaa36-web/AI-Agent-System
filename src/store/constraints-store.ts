import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isNotFoundError } from "./run-store";

/**
 * One correction, recorded permanently instead of living only inside a
 * single conversation. Mirrors CONSTRAINTS.md from the graph-workflow
 * pattern: "every time you correct something, the correction goes here
 * instead of into a chat message that disappears."
 */
export interface Constraint {
  readonly id: string;
  readonly text: string;
  readonly recordedAt: string;
}

/** Where corrections accumulate, so future Runs stop re-making (and re-paying to re-discover) the same mistake. */
export interface ConstraintsStore {
  add(text: string): Promise<Constraint>;
  list(): Promise<readonly Constraint[]>;
}

export class InMemoryConstraintsStore implements ConstraintsStore {
  private constraints: Constraint[] = [];

  async add(text: string): Promise<Constraint> {
    const constraint: Constraint = { id: randomUUID(), text, recordedAt: new Date().toISOString() };
    this.constraints = [...this.constraints, constraint];
    return constraint;
  }

  async list(): Promise<readonly Constraint[]> {
    return this.constraints;
  }
}

/** Persists all constraints as one JSON array file, written atomically the same way JsonFileRunStore does (temp file + rename). */
export class JsonFileConstraintsStore implements ConstraintsStore {
  constructor(private readonly path: string) {}

  async add(text: string): Promise<Constraint> {
    const constraint: Constraint = { id: randomUUID(), text, recordedAt: new Date().toISOString() };
    const existing = await this.list();
    const updated = [...existing, constraint];

    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(updated, null, 2), "utf-8");
    await rename(temporary, this.path);

    return constraint;
  }

  async list(): Promise<readonly Constraint[]> {
    try {
      const raw = await readFile(this.path, "utf-8");
      return JSON.parse(raw) as Constraint[];
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }
}

/**
 * Renders accumulated constraints as a block to prepend to an Agent's
 * system prompt. Returns an empty string when there are none, so callers
 * can always concatenate it without an extra branch.
 */
export function formatConstraintsForPrompt(constraints: readonly Constraint[]): string {
  if (constraints.length === 0) return "";
  const lines = constraints.map((c) => `- (${c.recordedAt.slice(0, 10)}) ${c.text}`).join("\n");
  return (
    "Corrections learned from past runs — apply these, and do not repeat the mistakes " +
    `they describe:\n${lines}\n\n`
  );
}
