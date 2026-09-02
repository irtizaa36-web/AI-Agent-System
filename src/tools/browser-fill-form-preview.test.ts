import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserFillFormPreviewTool } from "./browser-fill-form-preview";
import { FakeFormFillingClient } from "../integrations/browser/fake-form-client";

test("browser-fill-form-preview returns the resulting field values without submitting anything", async () => {
  const fields = [{ selector: "#reason", label: "Reason for return", type: "select" }];
  const client = new FakeFormFillingClient(new Map([["https://example.com/return", fields]]));
  const tool = createBrowserFillFormPreviewTool(client);

  const output = await tool.execute({ url: "https://example.com/return", values: { "#reason": "Defective" } });

  assert.deepEqual(JSON.parse(output), [{ selector: "#reason", label: "Reason for return", type: "select", currentValue: "Defective" }]);
  assert.equal(client.submittedCalls.length, 0);
});

test("browser-fill-form-preview is not marked requiresApproval — it never submits anything", () => {
  const tool = createBrowserFillFormPreviewTool(new FakeFormFillingClient());
  assert.equal(tool.requiresApproval, false);
});

test("browser-fill-form-preview rejects an input missing values", async () => {
  const tool = createBrowserFillFormPreviewTool(new FakeFormFillingClient());
  await assert.rejects(() => Promise.resolve(tool.execute({ url: "https://example.com" })), /requires \{ "url": string/);
});
