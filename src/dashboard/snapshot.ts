import {
  coworkerTaskOverallStatus,
  type CoworkerAssignment,
  type CoworkerOverallStatus,
  type CoworkerTask,
  type CoworkerTaskUpdate,
} from "../coworker/task";
import type { AgentStatus, SelfReportedAgentStatus } from "./agent-status";
import type { Recommendation } from "./recommendation";

/** Shown even before they've ever self-reported, so the dashboard isn't empty on a fresh checkout. */
export const DEFAULT_AGENT_NAMES: readonly string[] = ["PinkyBaby", "Coordinator", "macmini", "Laptop2", "Riley", "Jordan"];

/**
 * How long a self-reported status is trusted before the dashboard shows the
 * agent as offline instead. A simple heuristic, not a precise health check:
 * generous enough to cover the slowest current check-in (Coordinator's,
 * every 2 hours) with margin, so a normal gap between check-ins never reads
 * as an outage.
 */
export const DEFAULT_STALE_AFTER_MS = 3 * 60 * 60 * 1000;

export type DisplayAgentStatus = SelfReportedAgentStatus | "offline" | "unknown";

export interface AgentView {
  readonly name: string;
  readonly status: DisplayAgentStatus;
  readonly currentTask?: string;
  readonly updatedAt?: string;
  /** True when `status` is "offline" specifically because the last report is too old — distinguishes that from never having reported at all. */
  readonly stale: boolean;
}

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly assignedTo: CoworkerAssignment;
  readonly overallStatus: CoworkerOverallStatus;
  readonly createdAt: string;
  readonly personas: ReadonlyArray<{ readonly persona: string; readonly status: string; readonly output?: string }>;
  /** The single most recent thing that happened on this project — an explicit progress note if there is one, otherwise the latest dispatch/result event. Lets an ongoing project with no "done" state still show something meaningful. */
  readonly mostRecentUpdate?: CoworkerTaskUpdate;
  /** Explicit progress notes only (not dispatch/result events), oldest first — the project's own mini history. */
  readonly updateHistory: readonly CoworkerTaskUpdate[];
}

export interface DashboardSnapshot {
  readonly generatedAt: string;
  readonly agents: readonly AgentView[];
  readonly projects: readonly ProjectView[];
  readonly recommendations: readonly Recommendation[];
}

function buildAgentView(name: string, status: AgentStatus | undefined, now: number, staleAfterMs: number): AgentView {
  if (!status) {
    return { name, status: "unknown", stale: false };
  }
  const ageMs = now - Date.parse(status.updatedAt);
  const stale = Number.isNaN(ageMs) || ageMs > staleAfterMs;
  return {
    name,
    status: stale ? "offline" : status.status,
    currentTask: status.currentTask,
    updatedAt: status.updatedAt,
    stale,
  };
}

/** The latest dispatch/result event across all personas, phrased as a progress note, so a task with no explicit update note still shows real recent activity. */
function latestResultAsUpdate(task: CoworkerTask): CoworkerTaskUpdate | undefined {
  let latest: CoworkerTaskUpdate | undefined;
  for (const [persona, result] of Object.entries(task.results)) {
    if (!result) continue;
    const at = result.finishedAt ?? result.dispatchedAt;
    if (!at) continue;
    const note = result.finishedAt
      ? `${result.status}${result.output ? ` — ${result.output}` : ""}`
      : "started working on this";
    if (!latest || at > latest.at) latest = { at, by: persona, note };
  }
  return latest;
}

function buildProjectView(task: CoworkerTask): ProjectView {
  const updateHistory = task.updates ?? [];
  const lastExplicitUpdate = updateHistory[updateHistory.length - 1];
  const latestActivity = latestResultAsUpdate(task);
  const mostRecentUpdate =
    lastExplicitUpdate && latestActivity
      ? lastExplicitUpdate.at > latestActivity.at
        ? lastExplicitUpdate
        : latestActivity
      : (lastExplicitUpdate ?? latestActivity);

  return {
    id: task.id,
    name: task.task,
    assignedTo: task.assignedTo,
    overallStatus: coworkerTaskOverallStatus(task),
    createdAt: task.createdAt,
    personas: Object.entries(task.results).map(([persona, result]) => ({
      persona,
      status: result?.status ?? "pending",
      output: result?.output,
    })),
    mostRecentUpdate,
    updateHistory,
  };
}

export function buildDashboardSnapshot(
  tasks: readonly CoworkerTask[],
  agentStatuses: readonly AgentStatus[],
  recommendations: readonly Recommendation[],
  now: Date = new Date(),
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): DashboardSnapshot {
  const statusByName = new Map(agentStatuses.map((s) => [s.name, s]));
  const agentNames = new Set([...DEFAULT_AGENT_NAMES, ...agentStatuses.map((s) => s.name)]);
  const nowMs = now.getTime();

  const agents = [...agentNames]
    .map((name) => buildAgentView(name, statusByName.get(name), nowMs, staleAfterMs))
    .sort((a, b) => a.name.localeCompare(b.name));

  const projects = [...tasks]
    .map(buildProjectView)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const sortedRecommendations = [...recommendations].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return { generatedAt: now.toISOString(), agents, projects, recommendations: sortedRecommendations };
}
