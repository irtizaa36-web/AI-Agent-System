import { test } from "node:test";
import assert from "node:assert/strict";
import { withSummarization, DEFAULT_MAX_CHARS, DEFAULT_CHEAP_MODEL } from "./with-summarization";
import { FakeProvider } from "../providers/fake";
import type { Tool } from "./tool";

function fakeTool(result: string): Tool {
  return {
    name: "fake-read",
    description: "returns a scripted result",
    inputSchema: { type: "object", properties: {} },
    async execute(): Promise<string> {
      return result;
    },
  };
}

test("withSummarization passes short results through untouched, without calling the cheap model", async () => {
  const provider = new FakeProvider([]);
  const tool = withSummarization(fakeTool("short content"), { provider });

  const result = await tool.execute({});

  assert.equal(result, "short content");
  assert.equal(provider.calls, 0);
});

test("withSummarization condenses results over the char threshold via the cheap model", async () => {
  const longContent = "x".repeat(DEFAULT_MAX_CHARS + 1);
  const provider = new FakeProvider([{ content: "the short version", toolCalls: [], stopReason: "end_turn" }]);
  const tool = withSummarization(fakeTool(longContent), { provider });

  const result = await tool.execute({});

  assert.equal(provider.calls, 1);
  assert.match(result, /^\[Condensed by claude-3-5-haiku-20241022/);
  assert.match(result, /the short version$/);
});

test("withSummarization respects a custom maxChars and cheapModel", async () => {
  const provider = new FakeProvider([{ content: "tiny", toolCalls: [], stopReason: "end_turn" }]);
  const tool = withSummarization(fakeTool("12345678901"), { provider, maxChars: 10, cheapModel: "cheap-test-model" });

  const result = await tool.execute({});

  assert.match(result, /^\[Condensed by cheap-test-model/);
  assert.match(result, /tiny$/);
});

test("withSummarization preserves the wrapped tool's name, description, and schema", () => {
  const provider = new FakeProvider([]);
  const inner = fakeTool("anything");
  const tool = withSummarization(inner, { provider });

  assert.equal(tool.name, inner.name);
  assert.equal(tool.description, inner.description);
  assert.equal(tool.inputSchema, inner.inputSchema);
});

test("DEFAULT_MAX_CHARS and DEFAULT_CHEAP_MODEL are exported for callers that need the same values", () => {
  assert.equal(typeof DEFAULT_MAX_CHARS, "number");
  assert.equal(typeof DEFAULT_CHEAP_MODEL, "string");
});
