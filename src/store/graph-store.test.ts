import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AliasResolver, InMemoryGraphStore, JsonFileGraphStore } from "./graph-store";

test("AliasResolver canonicalizes a known alias regardless of case/whitespace", () => {
  const resolver = new AliasResolver(new Map([["square", "Block Inc"], ["block", "Block Inc"]]));

  assert.equal(resolver.canonicalize("Square"), "Block Inc");
  assert.equal(resolver.canonicalize("  square  "), "Block Inc");
  assert.equal(resolver.canonicalize("Unrelated Co"), "Unrelated Co");
});

test("InMemoryGraphStore.upsertNode creates a new node when none exists", async () => {
  const store = new InMemoryGraphStore();

  const node = await store.upsertNode({ label: "Acme Corp", type: "company", sources: ["s1"], confidence: 0.7 });

  assert.equal(node.label, "Acme Corp");
  assert.deepEqual(await store.listNodes(), [node]);
});

test("InMemoryGraphStore.upsertNode merges into an existing node instead of duplicating it", async () => {
  const store = new InMemoryGraphStore();
  await store.upsertNode({ label: "Acme Corp", type: "company", sources: ["s1"], confidence: 0.5 });

  const merged = await store.upsertNode({ label: "Acme Corp", type: "company", sources: ["s2"], confidence: 0.9 });

  const nodes = await store.listNodes();
  assert.equal(nodes.length, 1);
  assert.deepEqual(merged.sources, ["s1", "s2"]);
  assert.equal(merged.confidence, 0.9);
});

test("InMemoryGraphStore.upsertNode dedupes aliases as the same node", async () => {
  const store = new InMemoryGraphStore(new Map([["square", "Block Inc"]]));
  await store.upsertNode({ label: "Block Inc", type: "company", sources: ["s1"], confidence: 0.6 });

  const merged = await store.upsertNode({ label: "Square", type: "company", sources: ["s2"], confidence: 0.6 });

  assert.equal((await store.listNodes()).length, 1);
  assert.equal(merged.label, "Block Inc");
});

test("InMemoryGraphStore keeps nodes of different types distinct even with the same label", async () => {
  const store = new InMemoryGraphStore();
  await store.upsertNode({ label: "Acme", type: "company", sources: [], confidence: 0.5 });
  await store.upsertNode({ label: "Acme", type: "person", sources: [], confidence: 0.5 });

  assert.equal((await store.listNodes()).length, 2);
});

test("InMemoryGraphStore.findNode resolves aliases the same way upsertNode does", async () => {
  const store = new InMemoryGraphStore(new Map([["square", "Block Inc"]]));
  await store.upsertNode({ label: "Block Inc", type: "company", sources: [], confidence: 0.5 });

  assert.ok(await store.findNode("Square", "company"));
  assert.equal(await store.findNode("Nonexistent", "company"), undefined);
});

test("InMemoryGraphStore.addEdge/listEdges round-trip", async () => {
  const store = new InMemoryGraphStore();
  const edge = { from: "n1", to: "n2", type: "shared_investor", evidence: "sec:001", confidence: 0.8 };

  await store.addEdge(edge);

  assert.deepEqual(await store.listEdges(), [edge]);
});

test("JsonFileGraphStore persists and dedupes across separate instances against the same file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "graph-store-test-"));
  const path = join(dir, "graph.json");
  try {
    const first = new JsonFileGraphStore(path, new Map([["square", "Block Inc"]]));
    await first.upsertNode({ label: "Block Inc", type: "company", sources: ["s1"], confidence: 0.6 });

    const second = new JsonFileGraphStore(path, new Map([["square", "Block Inc"]]));
    const merged = await second.upsertNode({ label: "Square", type: "company", sources: ["s2"], confidence: 0.9 });

    const nodes = await second.listNodes();
    assert.equal(nodes.length, 1);
    assert.deepEqual(merged.sources, ["s1", "s2"]);
    assert.equal(merged.confidence, 0.9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JsonFileGraphStore.listNodes/listEdges return empty arrays before the file exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "graph-store-test-"));
  const path = join(dir, "missing.json");
  try {
    const store = new JsonFileGraphStore(path);
    assert.deepEqual(await store.listNodes(), []);
    assert.deepEqual(await store.listEdges(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
