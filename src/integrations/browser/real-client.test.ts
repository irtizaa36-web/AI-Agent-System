import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserClientFromSession, RealBrowserClient } from "./real-client";

test("createBrowserClientFromSession returns undefined when no session file exists for the site", () => {
  assert.equal(createBrowserClientFromSession("a-site-that-has-never-logged-in"), undefined);
});

test("RealBrowserClient.getPageText fails with a clear message when no session has been saved yet", async () => {
  const client = new RealBrowserClient("a-site-that-has-never-logged-in");
  await assert.rejects(() => client.getPageText("https://example.test"), /No saved browser session/);
});
