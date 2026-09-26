/**
 * The port the orchestrator brief watcher depends on for read-only GitHub
 * access (ADR 0027). Deliberately narrow: list branches, list a directory,
 * read a file's content — exactly what "find a new brief file on a
 * claude/* branch" needs, and nothing that writes anything on GitHub
 * itself. Any write the watcher makes (a working-branch checkout, a
 * delegation-log commit) happens through local `git`, not this client —
 * see checkout.ts.
 */

export interface GitHubDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly sha: string;
  readonly type: "file" | "dir" | "other";
}

export interface GitHubClient {
  /** Branch names whose name starts with `prefix`, e.g. "claude/". */
  listBranches(prefix: string): Promise<readonly string[]>;

  /**
   * Entries directly inside `path` on `branch`. Returns an empty array if
   * the directory doesn't exist on that branch — that's the expected,
   * common case (most branches have no brief), not an error.
   */
  listDirectory(branch: string, path: string): Promise<readonly GitHubDirectoryEntry[]>;

  /** A file's raw text content on `branch`, or `undefined` if it doesn't exist there. */
  getFileContent(branch: string, path: string): Promise<string | undefined>;
}
