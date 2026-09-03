import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecommendation, withImplemented } from "./recommendation";

test("createRecommendation rejects an empty summary or scope", () => {
  assert.throws(() => createRecommendation("dashboard", "  "), /summary must not be empty/);
  assert.throws(() => createRecommendation("  ", "do something"), /scope must not be empty/);
});

test("createRecommendation starts unimplemented", () => {
  const r = createRecommendation("dashboard", "add a filter");
  assert.equal(r.implemented, false);
  assert.equal(r.implementedAt, undefined);
});

test("withImplemented marks it done, with a timestamp and optional details", () => {
  const r = createRecommendation("system", "fix the recipe");
  const done = withImplemented(r, "switched to node dist/cli/index.js");
  assert.equal(done.implemented, true);
  assert.ok(done.implementedAt);
  assert.equal(done.details, "switched to node dist/cli/index.js");
});
