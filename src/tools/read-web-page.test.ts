import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadWebPageTool } from "./read-web-page";
import { FakeBrowserClient } from "../integrations/browser/fake-client";

test("read-web-page returns the browser client's page text for the given url", async () => {
  const client = new FakeBrowserClient("sermo", new Map([["https://app.sermo.com/feed/for-you", "Survey A - $10 - 5 min"]]));
  const tool = createReadWebPageTool(client);

  const output = await tool.execute({ url: "https://app.sermo.com/feed/for-you" });

  assert.equal(output, "Survey A - $10 - 5 min");
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
