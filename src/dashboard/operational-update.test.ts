import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationalUpdate } from "./operational-update";

test("operational updates require concise authored provenance", () => {
  assert.throws(() => createOperationalUpdate("", "PinkyBaby", "agent"), /summary must not be empty/);
  assert.throws(() => createOperationalUpdate("merged dashboard work", "", "agent"), /author must not be empty/);
  const update = createOperationalUpdate("merged dashboard work", "PinkyBaby", "agent", "PR #19");
  assert.equal(update.provenance, "agent");
  assert.equal(update.details, "PR #19");
});
