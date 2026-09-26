import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadJobBoardPageTool } from "./read-job-board-page";
import { FakeBrowserClient } from "../integrations/browser/fake-client";

const noopSleep = async (): Promise<void> => {};
const CHROME = "Find jobs  Company reviews  Salaries  Post a job  Sign in  Filters  Sort  ".repeat(4);
const HOME = CHROME + "Search millions of jobs.";
const RESULTS = CHROME + "Job A - Marketing Manager";

test("read-job-board-page health-checks the board, then returns status ok and the page text", async () => {
  const url = "https://example-jobs.test/search?q=marketing";
  const client = new FakeBrowserClient("job-boards", new Map([["https://example-jobs.test/", HOME], [url, RESULTS]]));
  const tool = createReadJobBoardPageTool(client, { sleep: noopSleep });

  const output = await tool.execute({ url });

  assert.match(output, /\[ok\]\nstatus: ok\n/);
  assert.match(output, /Job A - Marketing Manager/);
  assert.deepEqual(client.requestedUrls, ["https://example-jobs.test/", url]);
});

test("read-job-board-page reports a zero-results board as empty, not blocked", async () => {
  const url = "https://example-jobs.test/search?q=zzz";
  const client = new FakeBrowserClient("job-boards", new Map([["https://example-jobs.test/", HOME], [url, CHROME + "No jobs found."]]));
  const output = await createReadJobBoardPageTool(client, { sleep: noopSleep }).execute({ url });
  assert.match(output, /status: empty/);
});

test("read-job-board-page: a failed health check skips reads on that board", async () => {
  const url = "https://down-jobs.test/search?q=marketing";
  const client = new FakeBrowserClient("job-boards", new Map([["https://down-jobs.test/", ""], [url, RESULTS]]));
  const tool = createReadJobBoardPageTool(client, { sleep: noopSleep });

  const first = await tool.execute({ url });
  const second = await tool.execute({ url });

  assert.match(first, /\[skipped\]\nstatus: blocked/);
  assert.match(second, /failed its health check/);
  assert.deepEqual(client.requestedUrls, ["https://down-jobs.test/"], "the search page is never read, and the health check isn't re-run");
});

test("read-job-board-page: one board tripping its breaker doesn't stop the others", async () => {
  const blockedUrls = [1, 2, 3, 4].map((n) => `https://bad-jobs.test/search?page=${n}`);
  const goodUrls = [1, 2].map((n) => `https://good-jobs.test/search?page=${n}`);
  const pages = new Map<string, string>([
    ["https://bad-jobs.test/", HOME],
    ["https://good-jobs.test/", HOME],
    ...blockedUrls.map((u) => [u, ""] as [string, string]),
    ...goodUrls.map((u) => [u, RESULTS] as [string, string]),
  ]);
  const client = new FakeBrowserClient("job-boards", pages);
  const tool = createReadJobBoardPageTool(client, { sleep: noopSleep });

  const output = await tool.execute({ urls: [...blockedUrls, goodUrls[0]!, goodUrls[1]!] });

  const sections = output.split("\n\n## ");
  assert.match(sections[0]!, /\[blocked\]/);
  assert.match(sections[2]!, /\[blocked\]/);
  assert.match(sections[3]!, /\[skipped\][\s\S]*tripped its circuit breaker/);
  assert.equal(client.requestedUrls.includes(blockedUrls[3]!), false, "the 4th page on the tripped board is never read");
  assert.match(sections[4]!, /\[ok\]/);
  assert.match(sections[5]!, /\[ok\]/);
  assert.doesNotMatch(output, /no content/i);
});

test("read-job-board-page rejects an input with no url", async () => {
  const tool = createReadJobBoardPageTool(new FakeBrowserClient("job-boards"));
  await assert.rejects(() => Promise.resolve(tool.execute({})), /requires an input of the shape/);
});

test("read-job-board-page's description states it cannot click or apply to a listing", () => {
  const tool = createReadJobBoardPageTool(new FakeBrowserClient("job-boards"));
  assert.match(tool.description, /no way for this tool to click, apply, or save/);
  assert.equal(tool.requiresApproval, undefined);
});
