import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Run } from "../core/run";

/** Where Run history is persisted. Core never depends on this — only the CLI (and later, an API) does. */
export interface RunStore {
  save(run: Run): Promise<void>;
  load(id: string): Promise<Run | undefined>;
  list(): Promise<readonly Run[]>;
}

/** An in-memory adapter — no I/O, useful for tests. */
export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, Run>();

  async save(run: Run): Promise<void> {
    this.runs.set(run.id, run);
  }

  async load(id: string): Promise<Run | undefined> {
    return this.runs.get(id);
  }

  async list(): Promise<readonly Run[]> {
    return [...this.runs.values()];
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Persists each Run as one JSON file per Run in a directory. The adapter the CLI uses by default. */
export class JsonFileRunStore implements RunStore {
  constructor(private readonly dir: string) {}

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async save(run: Run): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathFor(run.id), JSON.stringify(run, null, 2), "utf-8");
  }

  async load(id: string): Promise<Run | undefined> {
    try {
      const raw = await readFile(this.pathFor(id), "utf-8");
      return JSON.parse(raw) as Run;
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      throw error;
    }
  }

  async list(): Promise<readonly Run[]> {
    try {
      const files = await readdir(this.dir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      return await Promise.all(
        jsonFiles.map(async (file) => JSON.parse(await readFile(join(this.dir, file), "utf-8")) as Run),
      );
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }
}
