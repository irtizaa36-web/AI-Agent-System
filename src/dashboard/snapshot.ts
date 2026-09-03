import {
  coworkerTaskOverallStatus,
  type CoworkerAssignment,
  type CoworkerOverallStatus,
  type CoworkerTask,
  type CoworkerTaskUpdate,
} from "../coworker/task";
import type { AgentStatus, SelfReportedAgentStatus } from "./agent-status";
import type { Recommendation } from "./recommendation";
import type { OperationalUpdate } from "./operational-update";

/** Shown even before they've ever self-reported, so the dashboard isn't empty on a fresh checkout. */
export const DEFAULT_AGENT_NAMES: readonly string[] = ["PinkyBaby", "Coordinator", "macmini", "Laptop2", "Riley", "Jordan"];

/**
 * How long a self-reported status is trusted before the dashboard shows the
 * agent as offline instead. A simple heuristic, not a precise health check:
 * generous enough to cover the slowest current check-in (Jordan's, every
 * 6 hours) with a two-hour margin, so a normal gap between check-ins never
 * reads as an outage.
 */
export const DEFAULT_STALE_AFTER_MS = 8 * 60 * 60 * 1000;

export type DisplayAgentStatus = SelfReportedAgentStatus | "offline" | "unknown";

export interface AgentView {
  readonly name: string;
  readonly status: DisplayAgentStatus;
  /** The agent's original status, retained when a stale display status is derived from it. */
  readonly reportedStatus?: SelfReportedAgentStatus;
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

export type AttentionKind = "stuck" | "offline" | "failed";

/**
 * A read-only reason to review locally recorded work. `source` separates an
 * agent's report from a conclusion derived from that report's age.
 */
export interface AttentionItem {
  readonly kind: AttentionKind;
  readonly subject: string;
  readonly reason: string;
  readonly source: "Agent self-report" | "Derived from last self-report" | "Task result";
  readonly at: string;
  readonly projectId?: string;
  readonly detail?: string;
}

export interface DashboardSnapshot {
  readonly generatedAt: string;
  readonly agents: readonly AgentView[];
  readonly projects: readonly ProjectView[];
  readonly attention: readonly AttentionItem[];
  readonly operationalUpdates: readonly OperationalUpdate[];
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
    reportedStatus: status.status,
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

/**
 * Lower sorts first. Agents that need a look — stuck, or offline when they
 * were expected to check in — surface above ones that are simply fine, so
 * the person glancing at the dashboard sees what needs attention without
 * having to read every card. Alphabetical order was hiding this: a stuck
 * agent named "Zeta" used to sort dead last, behind a dozen idle ones.
 * Complements `buildAttentionItems` below rather than duplicating it: this
 * just orders the roster people already scan; that builds the explicit,
 * detailed "why" (including failed task results, which have no agent to
 * sort by at all).
 */
const AGENT_URGENCY: Record<DisplayAgentStatus, number> = { stuck: 0, offline: 1, working: 2, idle: 3, unknown: 4 };

function buildAttentionItems(agents: readonly AgentView[], tasks: readonly CoworkerTask[]): AttentionItem[] {
  const agentItems = agents.flatMap((agent): AttentionItem[] => {
    if (!agent.updatedAt) return [];
    const items: AttentionItem[] = [];
    if (agent.reportedStatus === "stuck") {
      items.push({
        kind: "stuck",
        subject: agent.name,
        reason: `${agent.name} reported being stuck`,
        source: "Agent self-report",
        at: agent.updatedAt,
        detail: agent.currentTask,
      });
    }
    if (agent.status === "offline") {
      items.push({
        kind: "offline",
        subject: agent.name,
        reason: `${agent.name}'s last report is stale`,
        source: "Derived from last self-report",
        at: agent.updatedAt,
        detail: agent.currentTask,
      });
    }
    return items;
  });
  const failedResultItems = tasks.flatMap((task): AttentionItem[] =>
    Object.entries(task.results).flatMap(([persona, result]) => {
      if (result?.status !== "failed") return [];
      return [{
        kind: "failed",
        subject: task.task,
        reason: `${persona} reported a failed result`,
        source: "Task result",
        at: result.finishedAt ?? result.dispatchedAt ?? task.createdAt,
        projectId: task.id,
        detail: result.output,
      }];
    }),
  );

  return [...agentItems, ...failedResultItems].sort((a, b) => b.at.localeCompare(a.at));
}

export function buildDashboardSnapshot(
  tasks: readonly CoworkerTask[],
  agentStatuses: readonly AgentStatus[],
  recommendations: readonly Recommendation[],
  now: Date = new Date(),
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
  operationalUpdates: readonly OperationalUpdate[] = [],
): DashboardSnapshot {
  const statusByName = new Map(agentStatuses.map((s) => [s.name, s]));
  const agentNames = new Set([...DEFAULT_AGENT_NAMES, ...agentStatuses.map((s) => s.name)]);
  const nowMs = now.getTime();

  const agents = [...agentNames]
    .map((name) => buildAgentView(name, statusByName.get(name), nowMs, staleAfterMs))
    .sort((a, b) => AGENT_URGENCY[a.status] - AGENT_URGENCY[b.status] || a.name.localeCompare(b.name));

  const projects = [...tasks]
    .map(buildProjectView)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const attention = buildAttentionItems(agents, tasks);

  const sortedRecommendations = [...recommendations].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    generatedAt: now.toISOString(),
    agents,
    projects,
    attention,
    recommendations: sortedRecommendations,
    operationalUpdates: [...operationalUpdates].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}
