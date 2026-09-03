import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "../store/run-store";
import type { Recommendation } from "./recommendation";

/** Persists the recommendations feed. One JSON file per recommendation, same pattern as CoworkerTaskStore. */
export interface RecommendationStore {
  list(): Promise<readonly Recommendation[]>;
  save(recommendation: Recommendation): Promise<void>;
}

export class InMemoryRecommendationStore implements RecommendationStore {
  private readonly recommendations = new Map<string, Recommendation>();

  async list(): Promise<readonly Recommendation[]> {
    return [...this.recommendations.values()];
  }

  async save(recommendation: Recommendation): Promise<void> {
    this.recommendations.set(recommendation.id, recommendation);
  }
}

export class JsonFileRecommendationStore implements RecommendationStore {
  constructor(private readonly dir: string) {}

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async list(): Promise<readonly Recommendation[]> {
    try {
      const files = await readdir(this.dir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      return await Promise.all(
        jsonFiles.map(async (file) => JSON.parse(await readFile(join(this.dir, file), "utf-8")) as Recommendation),
      );
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }

  async save(recommendation: Recommendation): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathFor(recommendation.id), `${JSON.stringify(recommendation, null, 2)}\n`, "utf-8");
  }
}
