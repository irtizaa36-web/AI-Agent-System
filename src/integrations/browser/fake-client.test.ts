import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBrowserClient } from "./fake-client";

test("FakeBrowserClient returns the fixture text for a known URL", async () => {
  const client = new FakeBrowserClient("sermo", new Map([["https://app.sermo.com/feed/for-you", "Survey A - $10 - 5 min"]]));
  assert.equal(await client.getPageText("https://app.sermo.com/feed/for-you"), "Survey A - $10 - 5 min");
});

test("FakeBrowserClient throws a clear error for an unknown URL rather than returning empty text", async () => {
  const client = new FakeBrowserClient("sermo");
  await assert.rejects(() => client.getPageText("https://app.sermo.com/unknown"), /no fixture page/);
});
