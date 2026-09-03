import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createDashboardServer } from "./server";
import { InMemoryCoworkerTaskStore } from "../coworker/store";
import { InMemoryAgentStatusStore } from "./agent-status-store";
import { InMemoryRecommendationStore } from "./recommendation-store";
import { createCoworkerTask } from "../coworker/task";
import { createAgentStatus } from "./agent-status";
import { createRecommendation } from "./recommendation";

async function withServer(
  fn: (baseUrl: string, deps: { coworkerStore: InMemoryCoworkerTaskStore; agentStatusStore: InMemoryAgentStatusStore; recommendationStore: InMemoryRecommendationStore }) => Promise<void>,
): Promise<void> {
  const deps = {
    coworkerStore: new InMemoryCoworkerTaskStore(),
    agentStatusStore: new InMemoryAgentStatusStore(),
    recommendationStore: new InMemoryRecommendationStore(),
  };
  const server = createDashboardServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://localhost:${port}`, deps);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("GET / serves the dashboard HTML page", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.match(body, /Coworker Dashboard/);
  });
});

test("GET /api/snapshot reflects live store contents as JSON", async () => {
  await withServer(async (baseUrl, deps) => {
    await deps.coworkerStore.save(createCoworkerTask("do a thing", "macmini", "task-1"));
    await deps.agentStatusStore.save(createAgentStatus("macmini", "working", "task-1"));
    await deps.recommendationStore.save(createRecommendation("dashboard", "add dark mode"));

    const res = await fetch(`${baseUrl}/api/snapshot`);
    assert.equal(res.status, 200);
    const snapshot = (await res.json()) as {
      agents: { name: string; status: string }[];
      projects: { id: string }[];
      recommendations: { summary: string }[];
    };
    assert.ok(snapshot.agents.some((a) => a.name === "macmini" && a.status === "working"));
    assert.ok(snapshot.projects.some((p) => p.id === "task-1"));
    assert.ok(snapshot.recommendations.some((r) => r.summary === "add dark mode"));
  });
});

test("an unknown path returns 404", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/nope`);
    assert.equal(res.status, 404);
  });
});
