import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDashboardSnapshot, DEFAULT_AGENT_NAMES } from "./snapshot";
import { createAgentStatus } from "./agent-status";
import { createCoworkerTask, withDispatched, withResult, withUpdate } from "../coworker/task";
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

test("a six-hour-old report remains current for the documented slowest check-in", () => {
  const sixHoursAgo = new Date(NOW.getTime() - 6 * 60 * 60 * 1000).toISOString();
  const status = createAgentStatus("Jordan", "idle", undefined, sixHoursAgo);
  const snap = buildDashboardSnapshot([], [status], [], NOW);
  const jordan = snap.agents.find((a) => a.name === "Jordan");
  assert.equal(jordan?.status, "idle");
  assert.equal(jordan?.stale, false);
});

test("a status older than the stale threshold displays as offline", () => {
  const nineHoursAgo = new Date(NOW.getTime() - 9 * 60 * 60 * 1000).toISOString();
  const status = createAgentStatus("Laptop2", "idle", undefined, nineHoursAgo);
  const snap = buildDashboardSnapshot([], [status], [], NOW);
  const laptop = snap.agents.find((a) => a.name === "Laptop2");
  assert.equal(laptop?.status, "offline");
  assert.equal(laptop?.stale, true);
});

test("attention explains stuck, stale, and failed local records", () => {
  const stuck = createAgentStatus("Riley", "stuck", "task-a", NOW.toISOString());
  const stale = createAgentStatus("Jordan", "idle", "task-b", new Date(NOW.getTime() - 9 * 60 * 60 * 1000).toISOString());
  const failed = withResult(createCoworkerTask("repair local dashboard", "macmini", "task-c"), "macmini", "build failed", false);

  const snap = buildDashboardSnapshot([failed], [stuck, stale], [], NOW);

  assert.deepEqual(
    snap.attention.map((item) => [item.kind, item.source, item.projectId, item.detail]),
    [
      ["failed", "Task result", "task-c", "build failed"],
      ["stuck", "Agent self-report", undefined, "task-a"],
      ["offline", "Derived from last self-report", undefined, "task-b"],
    ],
  );
});

test("attention preserves a stale agent's self-reported stuck signal alongside offline", () => {
  const staleStuck = createAgentStatus(
    "Riley",
    "stuck",
    "waiting for approval",
    new Date(NOW.getTime() - 9 * 60 * 60 * 1000).toISOString(),
  );

  const snap = buildDashboardSnapshot([], [staleStuck], [], NOW);

  assert.deepEqual(
    snap.attention.map((item) => [item.kind, item.source, item.detail]),
    [
      ["stuck", "Agent self-report", "waiting for approval"],
      ["offline", "Derived from last self-report", "waiting for approval"],
    ],
  );
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

test("mostRecentUpdate falls back to the latest dispatch/result event when there's no explicit progress note", () => {
  const task = withResult(withDispatched(createCoworkerTask("do a thing", "macmini", "task-c"), "macmini"), "macmini", "all done", true);
  const snap = buildDashboardSnapshot([task], [], [], NOW);
  const project = snap.projects.find((p) => p.id === "task-c");
  assert.equal(project?.mostRecentUpdate?.by, "macmini");
  assert.match(project?.mostRecentUpdate?.note ?? "", /succeeded/);
  assert.deepEqual(project?.updateHistory, []);
});

test("an explicit progress note newer than the latest result event wins as mostRecentUpdate", () => {
  let task = withResult(withDispatched(createCoworkerTask("do a thing", "macmini", "task-d"), "macmini"), "macmini", "done", true);
  task = withUpdate(task, "Irtiza", "looks good, thanks!", "2026-09-04T00:00:00.000Z");
  const snap = buildDashboardSnapshot([task], [], [], NOW);
  const project = snap.projects.find((p) => p.id === "task-d");
  assert.equal(project?.mostRecentUpdate?.by, "Irtiza");
  assert.equal(project?.mostRecentUpdate?.note, "looks good, thanks!");
  assert.equal(project?.updateHistory.length, 1);
});

test("a project with no activity at all has no mostRecentUpdate", () => {
  const task = createCoworkerTask("brand new", "macmini", "task-e");
  const snap = buildDashboardSnapshot([task], [], [], NOW);
  const project = snap.projects.find((p) => p.id === "task-e");
  assert.equal(project?.mostRecentUpdate, undefined);
});

test("recommendations are sorted newest first and carry implemented state through", () => {
  const first = createRecommendation("dashboard", "first thing", "rec-1");
  const second = withImplemented(createRecommendation("system", "second thing", "rec-2"), "fixed it");
  const snap = buildDashboardSnapshot([], [], [first, second], NOW);

  assert.equal(snap.recommendations.length, 2);
  assert.equal(snap.recommendations.find((r) => r.id === "rec-2")?.implemented, true);
});
