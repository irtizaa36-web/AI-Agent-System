import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthCheckedFormFillingClient } from "./health-checked-form-client";
import { FakeFormFillingClient } from "./fake-form-client";
import { createBrowserSubmitFormTool } from "../../tools/browser-submit-form";

const URL = "https://shop.test/returns";
const CONFIRMATION = "Shop  Orders  Returns  Help  ".repeat(8) + "Return request received — confirmation #12345.";

test("a blocked pre-fill page aborts before any submit", async () => {
  const inner = new FakeFormFillingClient(new Map(), CONFIRMATION, { pages: new Map([[URL, ""]]) });
  const client = new HealthCheckedFormFillingClient(inner);

  await assert.rejects(() => client.submitForm(undefined, URL, { "#reason": "Defective" }, "#submit"), /Aborted before submitting[\s\S]*Nothing was filled or clicked/);
  assert.equal(inner.submittedCalls.length, 0);
});

test("a blocked pre-fill page also aborts a preview fill", async () => {
  const inner = new FakeFormFillingClient(new Map(), CONFIRMATION, { pages: new Map([[URL, new Error("net::ERR_TIMED_OUT")]]) });
  await assert.rejects(() => new HealthCheckedFormFillingClient(inner).previewFormFill(undefined, URL, {}), /Aborted before filling/);
});

test("a clear confirmation page reports outcome submitted", async () => {
  const inner = new FakeFormFillingClient(new Map(), CONFIRMATION);
  const result = await new HealthCheckedFormFillingClient(inner).submitForm(undefined, URL, {}, "#submit");
  assert.equal(result.outcome, "submitted");
  assert.equal(inner.submittedCalls.length, 1);
});

test("a submit is attempted exactly once even when the result page is blank, and reported as unknown", async () => {
  const inner = new FakeFormFillingClient(new Map(), "");
  const result = await new HealthCheckedFormFillingClient(inner).submitForm(undefined, URL, {}, "#submit");
  assert.equal(inner.submittedCalls.length, 1);
  assert.equal(result.outcome, "unknown");
  assert.match(result.note!, /not retried/);
});

test("a submit that throws after the click is attempted once and reported as unknown, not thrown", async () => {
  const inner = new FakeFormFillingClient(new Map(), CONFIRMATION, { submitError: new Error("Target page crashed") });
  const result = await new HealthCheckedFormFillingClient(inner).submitForm(undefined, URL, {}, "#submit");
  assert.equal(inner.submittedCalls.length, 1);
  assert.equal(result.outcome, "unknown");
});

test("a tripped breaker prevents the next submission on that domain, but not on another", async () => {
  const inner = new FakeFormFillingClient(new Map(), "");
  const client = new HealthCheckedFormFillingClient(inner);
  for (let i = 0; i < 3; i++) {
    assert.equal((await client.submitForm(undefined, URL, {}, "#submit")).outcome, "unknown");
  }
  await assert.rejects(() => client.submitForm(undefined, URL, {}, "#submit"), /Submission refused[\s\S]*circuit breaker/);
  assert.equal(inner.submittedCalls.length, 3, "the 4th submission never reached the page");

  await client.submitForm(undefined, "https://other-shop.test/returns", {}, "#submit");
  assert.equal(inner.submittedCalls.length, 4);
});

test("browser-submit-form reports submitted:unknown for an ambiguous result and keeps its approval gate", async () => {
  const original = process.env["RETURNS_AUTOPILOT_ENABLED"];
  delete process.env["RETURNS_AUTOPILOT_ENABLED"];
  try {
    const inner = new FakeFormFillingClient(new Map(), "");
    const tool = createBrowserSubmitFormTool(new HealthCheckedFormFillingClient(inner));
    assert.equal(tool.requiresApproval, true);
    const output = await tool.execute({ url: URL, values: {}, submitSelector: "#submit" });
    assert.match(output, /^submitted:unknown\nneedsHumanVerification:true/);
    assert.doesNotMatch(output, /submitted:true/);
    assert.equal(inner.submittedCalls.length, 1);
  } finally {
    if (original !== undefined) process.env["RETURNS_AUTOPILOT_ENABLED"] = original;
  }
});
