import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkflow, createFailedWorkflow, parseWorkflowPlan } from "./workflow";

test("createWorkflow builds a running Workflow with pending steps, starting at step 0", () => {
  const workflow = createWorkflow("book a table", [
    { agentName: "personal-admin", instructions: "draft a reservation inquiry" },
  ]);

  assert.equal(workflow.status, "running");
  assert.equal(workflow.currentStepIndex, 0);
  assert.equal(workflow.steps.length, 1);
  assert.equal(workflow.steps[0].status, "pending");
  assert.equal(workflow.steps[0].agentName, "personal-admin");
});

test("createWorkflow with zero steps produces an already-failed workflow with a planningError", () => {
  const workflow = createWorkflow("do nothing useful", []);
  assert.equal(workflow.status, "failed");
  assert.match(workflow.planningError ?? "", /zero steps/);
  assert.ok(workflow.completedAt);
});

test("createFailedWorkflow produces a failed, already-completed workflow with no steps", () => {
  const workflow = createFailedWorkflow("goal", "some planning problem");
  assert.equal(workflow.status, "failed");
  assert.equal(workflow.steps.length, 0);
  assert.equal(workflow.planningError, "some planning problem");
  assert.ok(workflow.completedAt);
});

test("parseWorkflowPlan parses a well-formed single-step plan", () => {
  const parsed = parseWorkflowPlan('```json\n[{"agent": "personal-admin", "task": "draft an inquiry"}]\n```', ["personal-admin"]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.steps, [{ agentName: "personal-admin", instructions: "draft an inquiry" }]);
  }
});

test("parseWorkflowPlan parses a well-formed multi-step plan, preserving order", () => {
  const parsed = parseWorkflowPlan(
    '```json\n[{"agent": "a", "task": "first"}, {"agent": "b", "task": "second"}]\n```',
    ["a", "b"],
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.steps.map((s) => s.agentName), ["a", "b"]);
  }
});

test("parseWorkflowPlan accepts an explicit empty plan (Dispatcher found nothing to do)", () => {
  const parsed = parseWorkflowPlan("No available agent fits this goal.\n```json\n[]\n```", ["a"]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.steps, []);
});

test("parseWorkflowPlan rejects a response with no fenced json block", () => {
  const parsed = parseWorkflowPlan("Sure, I'll do that.", ["a"]);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.reason, /fenced/);
});

test("parseWorkflowPlan rejects invalid JSON inside the fenced block", () => {
  const parsed = parseWorkflowPlan("```json\nnot json\n```", ["a"]);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.reason, /not valid JSON/);
});

test("parseWorkflowPlan rejects a non-array JSON value", () => {
  const parsed = parseWorkflowPlan('```json\n{"agent": "a", "task": "x"}\n```', ["a"]);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.reason, /JSON array/);
});

test("parseWorkflowPlan rejects a step missing agent or task", () => {
  const parsed = parseWorkflowPlan('```json\n[{"agent": "a"}]\n```', ["a"]);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.reason, /must have string "agent" and "task"/);
});

test("parseWorkflowPlan rejects a step naming an agent that isn't available, rather than dropping it silently", () => {
  const parsed = parseWorkflowPlan('```json\n[{"agent": "made-up-agent", "task": "x"}]\n```', ["a", "b"]);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.reason, /unknown agent "made-up-agent"/);
});
