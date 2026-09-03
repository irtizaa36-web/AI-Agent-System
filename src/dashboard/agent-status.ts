/**
 * An agent's own report of what it's doing right now. Deliberately doesn't
 * include "offline" — an agent that's actually offline can't report that
 * about itself. Whether a status is stale (and should display as offline)
 * is computed later, in snapshot.ts, from `updatedAt`.
 */
export type SelfReportedAgentStatus = "idle" | "working" | "stuck";

export const SELF_REPORTED_AGENT_STATUSES: readonly SelfReportedAgentStatus[] = ["idle", "working", "stuck"];

/**
 * One agent's latest self-reported status — Coordinator (Sam), macmini
 * (Max), Laptop2 (Lucy), or any agent created later. Not restricted to a
 * fixed list of names, unlike `CoworkerPersona`, since agents get added
 * over time.
 */
export interface AgentStatus {
  readonly name: string;
  readonly status: SelfReportedAgentStatus;
  /** Free text — a coworker task id, a short description, or omitted when idle. */
  readonly currentTask?: string;
  readonly updatedAt: string;
}

export function createAgentStatus(
  name: string,
  status: SelfReportedAgentStatus,
  currentTask?: string,
  updatedAt: string = new Date().toISOString(),
): AgentStatus {
  if (name.trim().length === 0) {
    throw new Error("Agent name must not be empty");
  }
  return { name, status, currentTask, updatedAt };
}

/** A filesystem-safe id for a JSON-file-per-agent store — case-insensitive so "macmini" and "MacMini" share one file. */
export function agentStatusFileId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}
