import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserListFormFieldsTool } from "./browser-list-form-fields";
import { FakeFormFillingClient } from "../integrations/browser/fake-form-client";

test("browser-list-form-fields returns the client's fields for the given url as JSON", async () => {
  const fields = [{ selector: "#reason", label: "Reason for return", type: "select" }];
  const client = new FakeFormFillingClient(new Map([["https://example.com/return", fields]]));
  const tool = createBrowserListFormFieldsTool(client);

  const output = await tool.execute({ url: "https://example.com/return" });

  assert.deepEqual(JSON.parse(output), fields);
});

test("browser-list-form-fields rejects an input with no url", async () => {
  const tool = createBrowserListFormFieldsTool(new FakeFormFillingClient());
  await assert.rejects(() => Promise.resolve(tool.execute({})), /requires \{ "url": string/);
});
