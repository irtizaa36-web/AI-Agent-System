import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Workflow } from "../core/workflow";
import { isNotFoundError } from "./run-store";

/** Where Workflow records are persisted. Same shape/role as RunStore, for the same reason (ADR 0008): Core never depends on this. */
export interface WorkflowStore {
  save(workflow: Workflow): Promise<void>;
  load(id: string): Promise<Workflow | undefined>;
  list(): Promise<readonly Workflow[]>;
}

export class InMemoryWorkflowStore implements WorkflowStore {
  private readonly workflows = new Map<string, Workflow>();

  async save(workflow: Workflow): Promise<void> {
    this.workflows.set(workflow.id, workflow);
  }

  async load(id: string): Promise<Workflow | undefined> {
    return this.workflows.get(id);
  }

  async list(): Promise<readonly Workflow[]> {
    return [...this.workflows.values()];
  }
}

export class JsonFileWorkflowStore implements WorkflowStore {
  constructor(private readonly dir: string) {}

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async save(workflow: Workflow): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathFor(workflow.id), JSON.stringify(workflow, null, 2), "utf-8");
  }

  async load(id: string): Promise<Workflow | undefined> {
    try {
      const raw = await readFile(this.pathFor(id), "utf-8");
      return JSON.parse(raw) as Workflow;
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      throw error;
    }
  }

  async list(): Promise<readonly Workflow[]> {
    try {
      const files = await readdir(this.dir);
      return await Promise.all(
        files.filter((f) => f.endsWith(".json")).map(async (file) => JSON.parse(await readFile(join(this.dir, file), "utf-8")) as Workflow),
      );
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }
}
