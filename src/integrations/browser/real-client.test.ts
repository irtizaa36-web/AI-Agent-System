import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserClientFromSession, createPublicBrowserClient, RealBrowserClient } from "./real-client";

test("createBrowserClientFromSession returns undefined when no session file exists for the site", () => {
  assert.equal(createBrowserClientFromSession("a-site-that-has-never-logged-in"), undefined);
});

test("RealBrowserClient.getPageText fails with a clear message when no session has been saved yet (default: session required)", async () => {
  const client = new RealBrowserClient("a-site-that-has-never-logged-in");
  await assert.rejects(() => client.getPageText("https://example.test"), /No saved browser session/);
});

test("createPublicBrowserClient never requires a session, even when none exists for the site", () => {
  const client = createPublicBrowserClient("a-site-that-has-never-logged-in");
  assert.ok(client instanceof RealBrowserClient);
  assert.equal(client.siteName, "a-site-that-has-never-logged-in");
});
