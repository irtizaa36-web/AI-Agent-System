import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserSubmitFormTool } from "./browser-submit-form";
import { FakeFormFillingClient } from "../integrations/browser/fake-form-client";

test("browser-submit-form is marked requiresApproval — the Orchestrator never auto-executes it", () => {
  const tool = createBrowserSubmitFormTool(new FakeFormFillingClient());
  assert.equal(tool.requiresApproval, true);
});

test("browser-submit-form fills, submits, and returns the confirmation text", async () => {
  const client = new FakeFormFillingClient(new Map(), "Return request received — confirmation #12345.");
  const tool = createBrowserSubmitFormTool(client);

  const output = await tool.execute({
    url: "https://example.com/return",
    values: { "#reason": "Defective" },
    submitSelector: "#submit-button",
    site: "lululemon",
  });

  assert.match(output, /submitted:true/);
  assert.match(output, /confirmation #12345/);
  assert.deepEqual(client.submittedCalls, [
    { site: "lululemon", url: "https://example.com/return", values: { "#reason": "Defective" }, submitSelector: "#submit-button" },
  ]);
});

test("browser-submit-form rejects an input missing submitSelector", async () => {
  const tool = createBrowserSubmitFormTool(new FakeFormFillingClient());
  await assert.rejects(
    () => Promise.resolve(tool.execute({ url: "https://example.com", values: {} })),
    /requires \{ "url": string/,
  );
});
