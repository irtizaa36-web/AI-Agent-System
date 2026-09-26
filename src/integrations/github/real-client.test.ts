import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubAPIError, RealGitHubClient, createGitHubClientFromEnv } from "./real-client";

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function fakeFetch(handler: FetchHandler): { fetchFn: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("listBranches sends the authorization header and filters by prefix", async () => {
  const { fetchFn, calls } = fakeFetch(() =>
    jsonResponse(200, [{ name: "main" }, { name: "claude/foo" }, { name: "claude/bar" }]),
  );
  const client = new RealGitHubClient("owner", "repo", "tok123", { fetchFn });

  const branches = await client.listBranches("claude/");

  assert.deepEqual([...branches].sort(), ["claude/bar", "claude/foo"]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/repos\/owner\/repo\/branches\?per_page=100&page=1$/);
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer tok123");
});

test("listBranches paginates until a short page is returned", async () => {
  let call = 0;
  const fullPage = Array.from({ length: 100 }, (_, i) => ({ name: `claude/${i}` }));
  const { fetchFn, calls } = fakeFetch(() => {
    call++;
    return call === 1 ? jsonResponse(200, fullPage) : jsonResponse(200, [{ name: "claude/last" }]);
  });
  const client = new RealGitHubClient("owner", "repo", "tok", { fetchFn });

  const branches = await client.listBranches("claude/");

  assert.equal(branches.length, 101);
  assert.equal(calls.length, 2);
});

test("listDirectory returns an empty array on a 404 (no briefs directory on this branch)", async () => {
  const { fetchFn } = fakeFetch(() => new Response(null, { status: 404 }));
  const client = new RealGitHubClient("owner", "repo", "tok", { fetchFn });
  assert.deepEqual(await client.listDirectory("claude/foo", "docs/delegation/briefs"), []);
});

test("listDirectory maps file entries and encodes the path", async () => {
  const { fetchFn, calls } = fakeFetch(() =>
    jsonResponse(200, [{ name: "task one.md", path: "docs/delegation/briefs/task one.md", sha: "abc", type: "file" }]),
  );
  const client = new RealGitHubClient("owner", "repo", "tok", { fetchFn });

  const entries = await client.listDirectory("claude/foo", "docs/delegation/briefs");

  assert.deepEqual(entries, [{ name: "task one.md", path: "docs/delegation/briefs/task one.md", sha: "abc", type: "file" }]);
  assert.match(calls[0].url, /docs\/delegation\/briefs\?ref=claude%2Ffoo$/);
});

test("listDirectory returns an empty array when the path points at a file, not a directory", async () => {
  const { fetchFn } = fakeFetch(() => jsonResponse(200, { name: "a.md", path: "a.md", sha: "x", type: "file", content: "" }));
  const client = new RealGitHubClient("owner", "repo", "tok", { fetchFn });
  assert.deepEqual(await client.listDirectory("claude/foo", "a.md"), []);
});

test("getFileContent decodes base64 content", async () => {
  const encoded = Buffer.from("# Title\n").toString("base64");
  const { fetchFn } = fakeFetch(() => jsonResponse(200, { type: "file", content: encoded, encoding: "base64" }));
  const client = new RealGitHubClient("owner", "repo", "tok", { fetchFn });

  assert.equal(await client.getFileContent("claude/foo", "docs/delegation/briefs/a.md"), "# Title\n");
});

test("getFileContent returns undefined for a 404", async () => {
  const { fetchFn } = fakeFetch(() => new Response(null, { status: 404 }));
  const client = new RealGitHubClient("owner", "repo", "tok", { fetchFn });
  assert.equal(await client.getFileContent("claude/foo", "missing.md"), undefined);
});

test("a non-404 error response throws GitHubAPIError with the status code", async () => {
  const { fetchFn } = fakeFetch(() => new Response("rate limited", { status: 403, statusText: "Forbidden" }));
  const client = new RealGitHubClient("owner", "repo", "tok", { fetchFn });

  await assert.rejects(() => client.listBranches("claude/"), (error: unknown) => {
    assert.ok(error instanceof GitHubAPIError);
    assert.equal(error.statusCode, 403);
    return true;
  });
});

test("createGitHubClientFromEnv throws a clear error when GITHUB_TOKEN is unset", () => {
  assert.throws(() => createGitHubClientFromEnv({}), /GITHUB_TOKEN/);
});

test("createGitHubClientFromEnv defaults owner/repo to this project's own repository", () => {
  // No throw, and no network call is made just constructing the client.
  const client = createGitHubClientFromEnv({ GITHUB_TOKEN: "tok" });
  assert.ok(client instanceof RealGitHubClient);
});
