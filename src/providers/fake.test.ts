import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeProvider, createEchoProvider } from "./fake";

const request = { model: "any", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

test("FakeProvider returns scripted responses in order", async () => {
  const provider = new FakeProvider([
    { content: "first", toolCalls: [], stopReason: "end_turn" },
    { content: "second", toolCalls: [], stopReason: "end_turn" },
  ]);

  const first = await provider.generate(request);
  const second = await provider.generate(request);

  assert.equal(first.content, "first");
  assert.equal(second.content, "second");
  assert.equal(provider.calls, 2);
});

test("FakeProvider throws once its script is exhausted", async () => {
  const provider = new FakeProvider([{ content: "only", toolCalls: [], stopReason: "end_turn" }]);
  await provider.generate(request);

  await assert.rejects(() => provider.generate(request), /more generate\(\) calls/);
});

test("createEchoProvider echoes the last user message and ends the turn", async () => {
  const provider = createEchoProvider();

  const result = await provider.generate({
    model: "any",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "say hi" },
    ],
    tools: [],
  });

  assert.equal(result.content, "Echo: say hi");
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(result.toolCalls, []);
});
