import { test } from "node:test";
import assert from "node:assert/strict";
import { createGraphRecallTool } from "./graph-recall";
import { InMemoryGraphStore } from "../store/graph-store";

test("graph-recall reports no prior record for an unseen entity", async () => {
  const tool = createGraphRecallTool(new InMemoryGraphStore());

  const result = await tool.execute({ label: "Acme Corp" });

  assert.match(result, /No prior record of "Acme Corp"/);
});

test("graph-recall returns the known sources and confidence for a previously logged entity", async () => {
  const store = new InMemoryGraphStore();
  await store.upsertNode({ label: "Acme Corp", type: "company", sources: ["https://a.example"], confidence: 0.8 });
  const tool = createGraphRecallTool(store);

  const result = await tool.execute({ label: "Acme Corp" });
  const parsed = JSON.parse(result);

  assert.equal(parsed.label, "Acme Corp");
  assert.deepEqual(parsed.sources, ["https://a.example"]);
  assert.equal(parsed.confidence, 0.8);
});

test("graph-recall defaults type to company and respects an explicit type", async () => {
  const store = new InMemoryGraphStore();
  await store.upsertNode({ label: "Acme", type: "person", sources: [], confidence: 0.5 });
  const tool = createGraphRecallTool(store);

  assert.match(await tool.execute({ label: "Acme" }), /No prior record/);
  assert.doesNotMatch(await tool.execute({ label: "Acme", type: "person" }), /No prior record/);
});

test("graph-recall rejects input with no label", async () => {
  const tool = createGraphRecallTool(new InMemoryGraphStore());
  await assert.rejects(async () => tool.execute({}));
});
