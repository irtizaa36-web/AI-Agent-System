import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadJobBoardPageTool } from "./read-job-board-page";
import { FakeBrowserClient } from "../integrations/browser/fake-client";

test("read-job-board-page returns the browser client's page text for the given url", async () => {
  const client = new FakeBrowserClient("job-boards", new Map([["https://example-jobs.test/search?q=marketing", "Job A - Marketing Manager"]]));
  const tool = createReadJobBoardPageTool(client);

  const output = await tool.execute({ url: "https://example-jobs.test/search?q=marketing" });

  assert.equal(output, "Job A - Marketing Manager");
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
