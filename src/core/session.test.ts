import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, appendMessage } from "./session";

test("createSession seeds a system message and a user message", () => {
  const session = createSession("be helpful", "say hi");

  assert.deepEqual(session.messages, [
    { role: "system", content: "be helpful" },
    { role: "user", content: "say hi" },
  ]);
});

test("appendMessage returns a new session without mutating the original", () => {
  const original = createSession("be helpful", "say hi");

  const next = appendMessage(original, { role: "assistant", content: "hello!" });

  assert.equal(original.messages.length, 2);
  assert.equal(next.messages.length, 3);
  assert.equal(next.messages[2]?.content, "hello!");
});
