import { test } from "node:test";
import assert from "node:assert/strict";
import { coworkerTaskOverallStatus, createCoworkerTask, personasFor, withDispatched, withResult } from "./task";

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

test("withResult records output, success/failure, and a finish time", () => {
  const task = createCoworkerTask("do a thing", "macmini");
  const failed = withResult(task, "macmini", "hit an error", false);
  assert.equal(failed.results.macmini?.status, "failed");
  assert.equal(failed.results.macmini?.output, "hit an error");
  assert.ok(failed.results.macmini?.finishedAt);
});
