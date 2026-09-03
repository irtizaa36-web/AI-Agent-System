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

test("POST /api/tasks creates a task the same way the CLI would", async () => {
  await withServer(async (baseUrl, deps) => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "look into the wifi router", assignedTo: "Laptop2" }),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()) as { id: string; task: string; assignedTo: string };
    assert.equal(created.task, "look into the wifi router");
    assert.equal(created.assignedTo, "Laptop2");

    const stored = await deps.coworkerStore.list();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.id, created.id);
  });
});

test("POST /api/tasks rejects a missing task or an invalid assignee", async () => {
  await withServer(async (baseUrl) => {
    const missingTask = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignedTo: "macmini" }),
    });
    assert.equal(missingTask.status, 400);

    const badAssignee = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "do a thing", assignedTo: "nobody" }),
    });
    assert.equal(badAssignee.status, 400);
  });
});

test("POST /api/tasks/:id/updates appends a progress note to an existing task", async () => {
  await withServer(async (baseUrl, deps) => {
    const task = createCoworkerTask("do a thing", "macmini", "task-1");
    await deps.coworkerStore.save(task);

    const res = await fetch(`${baseUrl}/api/tasks/task-1/updates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ by: "Irtiza", note: "any progress?" }),
    });
    assert.equal(res.status, 200);

    const [stored] = await deps.coworkerStore.list();
    assert.equal(stored?.updates?.length, 1);
    assert.equal(stored?.updates?.[0]?.note, "any progress?");
  });
});

test("POST /api/tasks/:id/updates 404s for an unknown task", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/tasks/no-such-id/updates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ by: "Irtiza", note: "hi" }),
    });
    assert.equal(res.status, 404);
  });
});
