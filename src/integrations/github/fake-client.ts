import type { GitHubClient, GitHubDirectoryEntry } from "./client";

interface FakeFile {
  readonly content: string;
  readonly sha: string;
}

/**
 * A deterministic, in-memory stand-in for the real GitHub API. Tests build
 * one with `seedBranch`/`seedFile` and never touch the network — the same
 * fake/real split every other integration in this repo uses (see
 * FakeInkboxClient).
 */
export class FakeGitHubClient implements GitHubClient {
  private readonly branches = new Map<string, Map<string, FakeFile>>();
  private shaCounter = 0;

  /** Registers a branch so it shows up in `listBranches`, even with no files yet. */
  seedBranch(branch: string): void {
    if (!this.branches.has(branch)) this.branches.set(branch, new Map());
  }

  /** Adds or replaces a file on a branch. A fresh sha is minted unless one is given, so re-seeding the same path with new content reads as "changed" to the watcher. */
  seedFile(branch: string, path: string, content: string, sha?: string): void {
    this.seedBranch(branch);
    this.branches.get(branch)!.set(path, { content, sha: sha ?? `fake-sha-${++this.shaCounter}` });
  }

  removeFile(branch: string, path: string): void {
    this.branches.get(branch)?.delete(path);
  }

  async listBranches(prefix: string): Promise<readonly string[]> {
    return [...this.branches.keys()].filter((name) => name.startsWith(prefix));
  }

  async listDirectory(branch: string, path: string): Promise<readonly GitHubDirectoryEntry[]> {
    const files = this.branches.get(branch);
    if (!files) return [];
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const entries: GitHubDirectoryEntry[] = [];
    for (const [filePath, file] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (rest.length === 0 || rest.includes("/")) continue; // only direct children, matching the real "contents" API
      entries.push({ name: rest, path: filePath, sha: file.sha, type: "file" });
    }
    return entries;
  }

  async getFileContent(branch: string, path: string): Promise<string | undefined> {
    return this.branches.get(branch)?.get(path)?.content;
  }
}
