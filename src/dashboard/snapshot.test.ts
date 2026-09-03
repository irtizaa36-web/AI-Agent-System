import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDashboardSnapshot, DEFAULT_AGENT_NAMES } from "./snapshot";
import { createAgentStatus } from "./agent-status";
import { createCoworkerTask, withDispatched, withResult } from "../coworker/task";
import { createRecommendation, withImplemented } from "./recommendation";

const NOW = new Date("2026-09-03T12:00:00.000Z");

test("agents with no status report at all show as unknown, not offline", () => {
  const snap = buildDashboardSnapshot([], [], [], NOW);
  assert.equal(snap.agents.length, DEFAULT_AGENT_NAMES.length);
  for (const agent of snap.agents) {
    assert.equal(agent.status, "unknown");
    assert.equal(agent.stale, false);
  }
});

test("a fresh self-reported status passes through as-is", () => {
  const status = createAgentStatus("macmini", "working", "task-1", NOW.toISOString());
  const snap = buildDashboardSnapshot([], [status], [], NOW);
  const macmini = snap.agents.find((a) => a.name === "macmini");
  assert.equal(macmini?.status, "working");
  assert.equal(macmini?.currentTask, "task-1");
  assert.equal(macmini?.stale, false);
});

test("a status older than the stale threshold displays as offline", () => {
  const fourHoursAgo = new Date(NOW.getTime() - 4 * 60 * 60 * 1000).toISOString();
  const status = createAgentStatus("Laptop2", "idle", undefined, fourHoursAgo);
  const snap = buildDashboardSnapshot([], [status], [], NOW);
  const laptop = snap.agents.find((a) => a.name === "Laptop2");
  assert.equal(laptop?.status, "offline");
  assert.equal(laptop?.stale, true);
});

test("an agent not in the default list still appears once it has reported at least once", () => {
  const status = createAgentStatus("NewHelper", "idle", undefined, NOW.toISOString());
  const snap = buildDashboardSnapshot([], [status], [], NOW);
  assert.ok(snap.agents.some((a) => a.name === "NewHelper"));
});

test("projects are built from coworker tasks, newest first, with per-persona detail", () => {
  const older = createCoworkerTask("older task", "macmini", "task-a", "2026-09-01T00:00:00.000Z");
  const newer = withResult(
    withDispatched(createCoworkerTask("newer task", "both", "task-b", "2026-09-02T00:00:00.000Z"), "macmini"),
    "macmini",
    "done",
    true,
  );
  const snap = buildDashboardSnapshot([older, newer], [], [], NOW);

  assert.equal(snap.projects.length, 2);
  assert.equal(snap.projects[0]?.id, "task-b");
  assert.equal(snap.projects[0]?.overallStatus, "in_progress");
  assert.equal(snap.projects[0]?.personas.find((p) => p.persona === "macmini")?.status, "succeeded");
  assert.equal(snap.projects[1]?.id, "task-a");
});

test("recommendations are sorted newest first and carry implemented state through", () => {
  const first = createRecommendation("dashboard", "first thing", "rec-1");
  const second = withImplemented(createRecommendation("system", "second thing", "rec-2"), "fixed it");
  const snap = buildDashboardSnapshot([], [], [first, second], NOW);

  assert.equal(snap.recommendations.length, 2);
  assert.equal(snap.recommendations.find((r) => r.id === "rec-2")?.implemented, true);
});
