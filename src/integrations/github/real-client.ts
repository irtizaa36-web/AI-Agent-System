import type { GitHubClient, GitHubDirectoryEntry } from "./client";

/**
 * The real GitHub REST API, called directly with `fetch` — no octokit/SDK
 * runtime dependency, the same zero-dependency rule the Inkbox real client
 * follows (ADR 0002, ADR 0006). Read-only: branches, directory listings,
 * file content. Nothing here can create, push, or modify anything on
 * GitHub — the watcher's only write path is local `git`, via checkout.ts.
 */
const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;
const PER_PAGE = 100;

export class GitHubAPIError extends Error {
  readonly statusCode: number;
  readonly detail: string;

  constructor(statusCode: number, detail: string) {
    super(`GitHub API error (HTTP ${statusCode}): ${detail}`);
    this.name = "GitHubAPIError";
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

interface RawBranch {
  readonly name: string;
}

interface RawContentEntry {
  readonly name: string;
  readonly path: string;
  readonly sha: string;
  readonly type: string;
}

interface RawFileContent {
  readonly type: string;
  readonly content?: string;
  readonly encoding?: string;
}

type FetchFn = typeof fetch;

export interface RealGitHubClientOptions {
  readonly baseUrl?: string;
  readonly fetchFn?: FetchFn;
  readonly timeoutMs?: number;
}

export class RealGitHubClient implements GitHubClient {
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(owner: string, repo: string, token: string, options: RealGitHubClientOptions = {}) {
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request(path: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "ai-agent-system-brief-watcher",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async listBranches(prefix: string): Promise<readonly string[]> {
    const names: string[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await this.request(
        `/repos/${this.owner}/${this.repo}/branches?per_page=${PER_PAGE}&page=${page}`,
      );
      if (!response.ok) {
        throw new GitHubAPIError(response.status, await safeText(response));
      }
      const raw = (await response.json()) as readonly RawBranch[];
      if (raw.length === 0) break;
      names.push(...raw.map((b) => b.name));
      if (raw.length < PER_PAGE) break;
    }
    return names.filter((name) => name.startsWith(prefix));
  }

  async listDirectory(branch: string, path: string): Promise<readonly GitHubDirectoryEntry[]> {
    const response = await this.request(
      `/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
    );
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new GitHubAPIError(response.status, await safeText(response));
    }
    const raw = await response.json();
    if (!Array.isArray(raw)) return []; // path pointed at a file, not a directory
    return (raw as readonly RawContentEntry[]).map((entry) => ({
      name: entry.name,
      path: entry.path,
      sha: entry.sha,
      type: entry.type === "file" ? "file" : entry.type === "dir" ? "dir" : "other",
    }));
  }

  async getFileContent(branch: string, path: string): Promise<string | undefined> {
    const response = await this.request(
      `/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
    );
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new GitHubAPIError(response.status, await safeText(response));
    }
    const raw = (await response.json()) as RawFileContent | readonly RawContentEntry[];
    if (Array.isArray(raw)) return undefined; // path pointed at a directory, not a file
    const file = raw as RawFileContent;
    if (file.type !== "file" || !file.content) return undefined;
    return Buffer.from(file.content, (file.encoding as BufferEncoding) ?? "base64").toString("utf-8");
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}

/**
 * Reads `GITHUB_TOKEN` (required — throws with a clear message if unset,
 * never silently falls back to an unauthenticated, low-rate-limit client)
 * plus optional `GITHUB_REPO_OWNER`/`GITHUB_REPO_NAME`, defaulting to this
 * project's own repository. Credentials come from the environment only,
 * never from a committed file (same rule as INKBOX_API_KEY).
 */
export function createGitHubClientFromEnv(env: NodeJS.ProcessEnv = process.env): RealGitHubClient {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set — the brief watcher needs a token with read access to list branches and files.");
  }
  const owner = env.GITHUB_REPO_OWNER ?? "irtizaa36-web";
  const repo = env.GITHUB_REPO_NAME ?? "AI-Agent-System";
  return new RealGitHubClient(owner, repo, token);
}
