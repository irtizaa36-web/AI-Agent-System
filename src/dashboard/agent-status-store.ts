import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "../store/run-store";
import { agentStatusFileId, type AgentStatus } from "./agent-status";

/** Persists each agent's latest self-reported status. One JSON file per agent, same pattern as CoworkerTaskStore. */
export interface AgentStatusStore {
  list(): Promise<readonly AgentStatus[]>;
  save(status: AgentStatus): Promise<void>;
}

export class InMemoryAgentStatusStore implements AgentStatusStore {
  private readonly statuses = new Map<string, AgentStatus>();

  async list(): Promise<readonly AgentStatus[]> {
    return [...this.statuses.values()];
  }

  async save(status: AgentStatus): Promise<void> {
    this.statuses.set(agentStatusFileId(status.name), status);
  }
}

export class JsonFileAgentStatusStore implements AgentStatusStore {
  constructor(private readonly dir: string) {}

  private pathFor(name: string): string {
    return join(this.dir, `${agentStatusFileId(name)}.json`);
  }

  async list(): Promise<readonly AgentStatus[]> {
    try {
      const files = await readdir(this.dir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      return await Promise.all(
        jsonFiles.map(async (file) => JSON.parse(await readFile(join(this.dir, file), "utf-8")) as AgentStatus),
      );
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }

  async save(status: AgentStatus): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathFor(status.name), `${JSON.stringify(status, null, 2)}\n`, "utf-8");
  }
}
