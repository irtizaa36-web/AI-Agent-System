import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadWebPageTool } from "./read-web-page";
import { FakeBrowserClient } from "../integrations/browser/fake-client";

const noopSleep = async (): Promise<void> => {};
const FEED_URL = "https://app.sermo.com/feed/for-you";
const FEED_TEXT = "Sermo  Feed  For you  Surveys  Messages  ".repeat(6) + "Survey A - $10 - 5 min";

test("read-web-page returns status ok and the page text for the given url", async () => {
  const client = new FakeBrowserClient("sermo", new Map([[FEED_URL, FEED_TEXT]]));
  const tool = createReadWebPageTool(client, { sleep: noopSleep });

  const output = await tool.execute({ url: FEED_URL });

  assert.equal(output, `status: ok\n\n${FEED_TEXT}`);
});

test("read-web-page: blocked, then ok on the paced retry, reports ok", async () => {
  const sleeps: number[] = [];
  const client = new FakeBrowserClient("sermo", new Map([[FEED_URL, ["", FEED_TEXT]]]));
  const tool = createReadWebPageTool(client, { sleep: async (ms) => void sleeps.push(ms) });

  const output = await tool.execute({ url: FEED_URL });

  assert.match(output, /^status: ok\n/);
  assert.match(output, /Survey A/);
  assert.equal(client.requestedUrls.length, 2);
  assert.equal(sleeps.length, 1, "exactly one paced wait before the retry");
});

test("read-web-page: blocked twice reports blocked and never says 'no content'", async () => {
  const client = new FakeBrowserClient("sermo", new Map([[FEED_URL, ["", "Something went wrong. Try reloading."]]]));
  const tool = createReadWebPageTool(client, { sleep: noopSleep });

  const output = await tool.execute({ url: FEED_URL });

  assert.match(output, /^status: blocked\n/);
  assert.doesNotMatch(output, /no content/i);
  assert.match(output, /not a quiet page/);
  assert.equal(client.requestedUrls.length, 2, "one retry, not more");
});

test("read-web-page: a load that throws twice reports error, not an exception or an empty page", async () => {
  const tool = createReadWebPageTool(new FakeBrowserClient("sermo"), { sleep: noopSleep });
  const output = await tool.execute({ url: FEED_URL });
  assert.match(output, /^status: error\n/);
  assert.doesNotMatch(output, /no content/i);
});

test("read-web-page rejects an input with no url", async () => {
  const tool = createReadWebPageTool(new FakeBrowserClient("sermo"));
  await assert.rejects(() => Promise.resolve(tool.execute({})), /requires an input of the shape/);
});

test("read-web-page's description states it cannot click, type, or submit anything", () => {
  const tool = createReadWebPageTool(new FakeBrowserClient("sermo"));
  assert.match(tool.description, /no way for this tool to click, type, submit/);
  assert.equal(tool.requiresApproval, undefined);
});
