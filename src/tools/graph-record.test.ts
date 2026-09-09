import { test } from "node:test";
import assert from "node:assert/strict";
import { createGraphRecordTool } from "./graph-record";
import { InMemoryGraphStore } from "../store/graph-store";

test("graph-record creates a new node with defaults for type and confidence", async () => {
  const store = new InMemoryGraphStore();
  const tool = createGraphRecordTool(store);

  const result = await tool.execute({ label: "Acme Corp", source: "https://a.example" });

  assert.match(result, /Recorded "Acme Corp" \(type: company\); 1 source\(s\) on file, confidence 0.7\./);
  const nodes = await store.listNodes();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].confidence, 0.7);
});

test("graph-record merges into an existing node rather than duplicating it", async () => {
  const store = new InMemoryGraphStore();
  const tool = createGraphRecordTool(store);

  await tool.execute({ label: "Acme Corp", source: "https://a.example", confidence: 0.6 });
  const result = await tool.execute({ label: "Acme Corp", source: "https://b.example", confidence: 0.9 });

  assert.match(result, /2 source\(s\) on file, confidence 0.9/);
  assert.equal((await store.listNodes()).length, 1);
});

test("graph-record rejects input missing label or source", async () => {
  const tool = createGraphRecordTool(new InMemoryGraphStore());
  await assert.rejects(async () => tool.execute({ label: "Acme Corp" }));
  await assert.rejects(async () => tool.execute({ source: "https://a.example" }));
});
