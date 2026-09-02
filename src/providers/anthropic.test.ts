import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequestBody, parseResponseBody, createAnthropicProvider } from "./anthropic";

test("buildRequestBody pulls the system message out separately", () => {
  const body = buildRequestBody({
    model: "claude-sonnet-5",
    messages: [
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
    ],
    tools: [],
  });

  assert.equal(body.system, "be helpful");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(body.model, "claude-sonnet-5");
});

test("buildRequestBody encodes an assistant tool call as a tool_use content block", () => {
  const body = buildRequestBody({
    model: "claude-sonnet-5",
    messages: [
      { role: "system", content: "be helpful" },
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        content: "calling a tool",
        toolCalls: [{ id: "call-1", toolName: "read-file", input: { path: "a.txt" } }],
      },
      { role: "tool", content: "file contents", toolCallId: "call-1" },
    ],
    tools: [{ name: "read-file", description: "reads a file", inputSchema: {} }],
  });

  assert.deepEqual(body.messages[1], {
    role: "assistant",
    content: [
      { type: "text", text: "calling a tool" },
      { type: "tool_use", id: "call-1", name: "read-file", input: { path: "a.txt" } },
    ],
  });
  assert.deepEqual(body.messages[2], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "call-1", content: "file contents" }],
  });
  assert.deepEqual(body.tools, [{ name: "read-file", description: "reads a file", input_schema: {} }]);
});

test("parseResponseBody joins text blocks and maps tool_use blocks", () => {
  const result = parseResponseBody({
    content: [
      { type: "text", text: "here you go: " },
      { type: "tool_use", id: "call-1", name: "read-file", input: { path: "a.txt" } },
    ],
    stop_reason: "tool_use",
  });

  assert.equal(result.content, "here you go: ");
  assert.deepEqual(result.toolCalls, [{ id: "call-1", toolName: "read-file", input: { path: "a.txt" } }]);
  assert.equal(result.stopReason, "tool_use");
});

test("createAnthropicProvider throws a clear error when no API key is available", async () => {
  const provider = createAnthropicProvider({ apiKey: undefined });
  const originalKey = process.env["ANTHROPIC_API_KEY"];
  delete process.env["ANTHROPIC_API_KEY"];

  try {
    await assert.rejects(
      () => provider.generate({ model: "claude-sonnet-5", messages: [], tools: [] }),
      /ANTHROPIC_API_KEY is not set/,
    );
  } finally {
    if (originalKey !== undefined) process.env["ANTHROPIC_API_KEY"] = originalKey;
  }
});
