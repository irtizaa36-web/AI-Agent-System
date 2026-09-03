import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "../store/run-store";
import type { CoworkerTask } from "./task";

/**
 * Persists the shared coworker task list. One JSON file per task (same
 * shape as RunStore), not one big array — the mac mini and laptop each work
 * from their own clone of this repo, and per-task files mean two machines
 * updating two different tasks around the same time never touch the same
 * file. Two personas finishing the *same* "both" task at the exact same
 * moment can still race on that one file; that's an acceptable, rare edge
 * case (a trivial JSON merge/retry) rather than something worth adding
 * infrastructure for.
 */
export interface CoworkerTaskStore {
  list(): Promise<readonly CoworkerTask[]>;
  save(task: CoworkerTask): Promise<void>;
}

export class InMemoryCoworkerTaskStore implements CoworkerTaskStore {
  private readonly tasks = new Map<string, CoworkerTask>();

  async list(): Promise<readonly CoworkerTask[]> {
    return [...this.tasks.values()];
  }

  async save(task: CoworkerTask): Promise<void> {
    this.tasks.set(task.id, task);
  }
}

/** Persists each task as its own JSON file in a directory — the adapter the CLI uses by default. */
export class JsonFileCoworkerTaskStore implements CoworkerTaskStore {
  constructor(private readonly dir: string) {}

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async list(): Promise<readonly CoworkerTask[]> {
    try {
      const files = await readdir(this.dir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      return await Promise.all(
        jsonFiles.map(async (file) => JSON.parse(await readFile(join(this.dir, file), "utf-8")) as CoworkerTask),
      );
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }

  async save(task: CoworkerTask): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathFor(task.id), `${JSON.stringify(task, null, 2)}\n`, "utf-8");
  }
}
