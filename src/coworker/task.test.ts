import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_COWORKER_PERSONAS,
  coworkerTaskOverallStatus,
  createCoworkerTask,
  personasFor,
  withDispatched,
  withPending,
  withResult,
  withUpdate,
} from "./task";

test("createCoworkerTask rejects empty task text", () => {
  assert.throws(() => createCoworkerTask("   ", "macmini"), /must not be empty/);
});

test("personasFor expands 'both' to both personas, and passes through a single persona", () => {
  assert.deepEqual(personasFor("both"), ["macmini", "Laptop2"]);
  assert.deepEqual(personasFor("macmini"), ["macmini"]);
  assert.deepEqual(personasFor("Laptop2"), ["Laptop2"]);
});

test("createCoworkerTask seeds a pending result for each assigned persona only", () => {
  const single = createCoworkerTask("do a thing", "macmini");
  assert.deepEqual(Object.keys(single.results), ["macmini"]);
  assert.equal(single.results.macmini?.status, "pending");

  const both = createCoworkerTask("do a thing", "both");
  assert.deepEqual(Object.keys(both.results).sort(), ["Laptop2", "macmini"]);
});

test("coworkerTaskOverallStatus is derived from per-persona results, never stored", () => {
  let task = createCoworkerTask("do a thing", "both");
  assert.equal(coworkerTaskOverallStatus(task), "pending");

  task = withDispatched(task, "macmini");
  assert.equal(coworkerTaskOverallStatus(task), "in_progress");

  task = withResult(task, "macmini", "done on macmini", true);
  assert.equal(coworkerTaskOverallStatus(task), "in_progress", "laptop hasn't reported yet");

  task = withResult(task, "Laptop2", "couldn't do it", false);
  assert.equal(coworkerTaskOverallStatus(task), "done", "done once every assigned persona has a final result");
});

test("withDispatched and withResult reject a persona the task isn't assigned to", () => {
  const task = createCoworkerTask("do a thing", "macmini");
  assert.throws(() => withDispatched(task, "Laptop2"), /not assigned/);
  assert.throws(() => withResult(task, "Laptop2", "x", true), /not assigned/);
});

test("withPending returns a dispatched task to the pickup queue and clears stale metadata", () => {
  const task = withDispatched(createCoworkerTask("do a thing", "macmini"), "macmini");
  const pending = withPending(task, "macmini");

  assert.equal(pending.results.macmini?.status, "pending");
  assert.equal(pending.results.macmini?.dispatchedAt, undefined);
  assert.equal(pending.results.macmini?.finishedAt, undefined);
  assert.equal(pending.results.macmini?.output, undefined);
  assert.equal(coworkerTaskOverallStatus(pending), "pending");
});

test("withPending rejects a task that was not dispatched", () => {
  const task = createCoworkerTask("do a thing", "macmini");
  assert.throws(() => withPending(task, "macmini"), /not dispatched/);
});

test("withResult records output, success/failure, and a finish time", () => {
  const task = createCoworkerTask("do a thing", "macmini");
  const failed = withResult(task, "macmini", "hit an error", false);
  assert.equal(failed.results.macmini?.status, "failed");
  assert.equal(failed.results.macmini?.output, "hit an error");
  assert.ok(failed.results.macmini?.finishedAt);
});

test("ALL_COWORKER_PERSONAS includes every specialist persona without changing what 'both' means", () => {
  assert.deepEqual(ALL_COWORKER_PERSONAS, ["macmini", "Laptop2", "Riley", "Jordan", "PinkyBaby"]);
  assert.deepEqual(personasFor("both"), ["macmini", "Laptop2"]);
});

test("withUpdate appends progress notes oldest-first, without touching results/status", () => {
  let task = createCoworkerTask("do a thing", "macmini");
  task = withUpdate(task, "macmini", "started looking into this");
  task = withUpdate(task, "Irtiza", "any luck?");
  assert.equal(task.updates?.length, 2);
  assert.equal(task.updates?.[0]?.note, "started looking into this");
  assert.equal(task.updates?.[1]?.by, "Irtiza");
  assert.equal(coworkerTaskOverallStatus(task), "pending", "an update note is not a status change");
});

test("withUpdate rejects an empty note, and doesn't require the poster to be an assigned persona", () => {
  const task = createCoworkerTask("do a thing", "macmini");
  assert.throws(() => withUpdate(task, "Irtiza", "   "), /must not be empty/);
  const updated = withUpdate(task, "Irtiza", "checking in");
  assert.equal(updated.updates?.[0]?.by, "Irtiza");
});
