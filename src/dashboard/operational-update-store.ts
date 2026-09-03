import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "../store/run-store";
import type { OperationalUpdate } from "./operational-update";

/** Persists concise operational handoffs as one committed JSON file per update. */
export interface OperationalUpdateStore {
  list(): Promise<readonly OperationalUpdate[]>;
  save(update: OperationalUpdate): Promise<void>;
}

export class InMemoryOperationalUpdateStore implements OperationalUpdateStore {
  private readonly updates = new Map<string, OperationalUpdate>();

  async list(): Promise<readonly OperationalUpdate[]> {
    return [...this.updates.values()];
  }

  async save(update: OperationalUpdate): Promise<void> {
    this.updates.set(update.id, update);
  }
}

export class JsonFileOperationalUpdateStore implements OperationalUpdateStore {
  constructor(private readonly dir: string) {}

  async list(): Promise<readonly OperationalUpdate[]> {
    try {
      const files = (await readdir(this.dir)).filter((file) => file.endsWith(".json"));
      return await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(this.dir, file), "utf-8")) as OperationalUpdate));
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }

  async save(update: OperationalUpdate): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${update.id}.json`), `${JSON.stringify(update, null, 2)}\n`, "utf-8");
  }
}
