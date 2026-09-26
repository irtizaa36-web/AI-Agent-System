import { test } from "node:test";
import assert from "node:assert/strict";
import { createXSearchSweepTool } from "./x-search-sweep";
import { FakeBrowserClient } from "../integrations/browser/fake-client";
import { xSearchUrl } from "../integrations/x-research/topics";
import { STANDING_X_TOPICS } from "../integrations/x-research/topics";

test("x-search-sweep tool returns the sweep result as JSON, health check included", async () => {
  const healthyHome = "Home / For you / " + "post ".repeat(60);
  const pages = new Map<string, string>([["https://x.com/home", healthyHome]]);
  for (const topic of STANDING_X_TOPICS) {
    pages.set(xSearchUrl(topic.query, { live: true }), "result text ".repeat(40));
  }
  const client = new FakeBrowserClient("x", pages);
  const tool = createXSearchSweepTool(client, { sleep: async () => {} });

  const output = await tool.execute({});
  const parsed = JSON.parse(output);

  assert.equal(parsed.sessionHealthy, true);
  assert.equal(parsed.results.length, STANDING_X_TOPICS.length);
  assert.ok(parsed.results.every((r: { status: string }) => r.status === "ok"));
});

test("x-search-sweep tool's description states it cannot like, reply, follow, or DM", () => {
  const tool = createXSearchSweepTool(new FakeBrowserClient("x"));
  assert.match(tool.description, /no way for this tool to like, reply, repost, follow, or DM/);
  assert.equal(tool.requiresApproval, undefined);
});
