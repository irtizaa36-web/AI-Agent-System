import { mkdir, readFile, readdir, rename, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ApplicationRecord, CompanyRecord, JobRecord } from "../jobsearch/records";
import { isNotFoundError } from "./run-store";

/**
 * Persistence for the job-search pipeline. Follows the same one-JSON-file-
 * per-record shape as JsonFileRunStore, under `.orchestrator/jobs/` — which
 * is already gitignored, so nothing here can reach GitHub by accident.
 *
 * Raw posting bodies are written to their own directory and referenced by
 * path. They are never loaded back into memory by the scoring path, which is
 * the whole reason the JobRecord carries a trimmed `summary` alongside a
 * `descriptionPath`: the expensive stage reads the small one.
 */

export interface JobStore {
  listJobs(): Promise<readonly JobRecord[]>;
  saveJobs(records: readonly JobRecord[]): Promise<void>;
  saveRawBody(contentHash: string, body: string): Promise<string>;
  listApplications(): Promise<readonly ApplicationRecord[]>;
  saveApplication(record: ApplicationRecord): Promise<void>;
  listCompanies(): Promise<readonly CompanyRecord[]>;
  saveCompany(record: CompanyRecord): Promise<void>;
}

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly applications = new Map<string, ApplicationRecord>();
  private readonly companies = new Map<string, CompanyRecord>();
  public readonly rawBodies = new Map<string, string>();

  async listJobs(): Promise<readonly JobRecord[]> {
    return [...this.jobs.values()];
  }

  async saveJobs(records: readonly JobRecord[]): Promise<void> {
    for (const record of records) this.jobs.set(record.id, record);
  }

  async saveRawBody(contentHash: string, body: string): Promise<string> {
    this.rawBodies.set(contentHash, body);
    return `memory://${contentHash}`;
  }

  async listApplications(): Promise<readonly ApplicationRecord[]> {
    return [...this.applications.values()];
  }

  async saveApplication(record: ApplicationRecord): Promise<void> {
    this.applications.set(record.id, record);
  }

  async listCompanies(): Promise<readonly CompanyRecord[]> {
    return [...this.companies.values()];
  }

  async saveCompany(record: CompanyRecord): Promise<void> {
    this.companies.set(record.id, record);
  }
}

export class JsonFileJobStore implements JobStore {
  constructor(private readonly dir: string) {}

  private get jobsDir(): string {
    return join(this.dir, "jobs");
  }
  private get rawDir(): string {
    return join(this.dir, "raw");
  }
  private get applicationsDir(): string {
    return join(this.dir, "applications");
  }
  private get companiesDir(): string {
    return join(this.dir, "companies");
  }

  /** Write-to-temp-then-rename, so a crash mid-write can never leave a half-written record behind. */
  private async writeRecord(dir: string, id: string, value: unknown): Promise<void> {
    await mkdir(dir, { recursive: true });
    const target = join(dir, `${id}.json`);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
    await rename(temp, target);
  }

  private async readAll<T>(dir: string): Promise<readonly T[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }

    const records: T[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      try {
        records.push(JSON.parse(await readFile(join(dir, name), "utf8")) as T);
      } catch {
        // One unreadable record must not blind the pipeline to every other
        // one — it would look exactly like "no jobs found today".
      }
    }
    return records;
  }

  async listJobs(): Promise<readonly JobRecord[]> {
    return this.readAll<JobRecord>(this.jobsDir);
  }

  async saveJobs(records: readonly JobRecord[]): Promise<void> {
    for (const record of records) await this.writeRecord(this.jobsDir, record.id, record);
  }

  async saveRawBody(contentHash: string, body: string): Promise<string> {
    await mkdir(this.rawDir, { recursive: true });
    const name = `${createHash("sha256").update(contentHash).digest("hex").slice(0, 32)}.html`;
    const path = join(this.rawDir, name);
    await writeFile(path, body, "utf8");
    return path;
  }

  async listApplications(): Promise<readonly ApplicationRecord[]> {
    return this.readAll<ApplicationRecord>(this.applicationsDir);
  }

  async saveApplication(record: ApplicationRecord): Promise<void> {
    await this.writeRecord(this.applicationsDir, record.id, record);
  }

  async listCompanies(): Promise<readonly CompanyRecord[]> {
    return this.readAll<CompanyRecord>(this.companiesDir);
  }

  async saveCompany(record: CompanyRecord): Promise<void> {
    await this.writeRecord(this.companiesDir, record.id, record);
  }

  /**
   * Drops raw bodies past the retention window. JobRecords are kept forever —
   * they are small, and the `seen` set is what stops the pipeline paying to
   * re-read the same posting for the rest of time.
   */
  async pruneRawBodies(olderThanDays: number, now = Date.now()): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.rawDir);
    } catch (error) {
      if (isNotFoundError(error)) return 0;
      throw error;
    }

    const cutoff = now - olderThanDays * 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const name of names) {
      const path = join(this.rawDir, name);
      const info = await stat(path);
      if (info.mtimeMs < cutoff) {
        await rm(path, { force: true });
        pruned += 1;
      }
    }
    return pruned;
  }
}
