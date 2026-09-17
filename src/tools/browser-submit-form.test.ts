import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserSubmitFormTool } from "./browser-submit-form";
import { FakeFormFillingClient } from "../integrations/browser/fake-form-client";

function withAutopilot(value: string | undefined, fn: () => void): void {
  const original = process.env["RETURNS_AUTOPILOT_ENABLED"];
  try {
    if (value === undefined) delete process.env["RETURNS_AUTOPILOT_ENABLED"];
    else process.env["RETURNS_AUTOPILOT_ENABLED"] = value;
    fn();
  } finally {
    if (original === undefined) delete process.env["RETURNS_AUTOPILOT_ENABLED"];
    else process.env["RETURNS_AUTOPILOT_ENABLED"] = original;
  }
}

test("browser-submit-form is marked requiresApproval by default — the Orchestrator never auto-executes it", () => {
  withAutopilot(undefined, () => {
    const tool = createBrowserSubmitFormTool(new FakeFormFillingClient());
    assert.equal(tool.requiresApproval, true);
  });
});

test("RETURNS_AUTOPILOT_ENABLED=true drops the approval gate, so the Orchestrator will auto-execute a live submit (ADR 0018)", () => {
  withAutopilot("true", () => {
    const tool = createBrowserSubmitFormTool(new FakeFormFillingClient());
    assert.equal(tool.requiresApproval, false);
  });
});

test("only the literal string \"true\" opens the gate — a truthy-looking value does not", () => {
  for (const value of ["1", "yes", "TRUE", "true ", ""]) {
    withAutopilot(value, () => {
      const tool = createBrowserSubmitFormTool(new FakeFormFillingClient());
      assert.equal(tool.requiresApproval, true, `${JSON.stringify(value)} must not be treated as enabled`);
    });
  }
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
