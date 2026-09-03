import { randomUUID } from "node:crypto";

/**
 * The two Claude Code sessions/personas this loop hands work to. Values are
 * exact peer session names — they must match what `SendMessage`'s `to`
 * field expects on the machine dispatching the task, so casing matters.
 */
export type CoworkerPersona = "macmini" | "Laptop2";

export const COWORKER_PERSONAS: readonly CoworkerPersona[] = ["macmini", "Laptop2"];

export type CoworkerAssignment = CoworkerPersona | "both";

export type CoworkerPersonaStatus = "pending" | "dispatched" | "succeeded" | "failed";

export interface CoworkerPersonaResult {
  readonly status: CoworkerPersonaStatus;
  readonly dispatchedAt?: string;
  readonly finishedAt?: string;
  readonly output?: string;
}

/**
 * One entry in the shared coworker task list: an idea/task, who it's
 * assigned to, and — per assigned persona — how far it's gotten. There is
 * no separate top-level status field; `coworkerTaskOverallStatus` derives
 * it from `results` so the two can never drift out of sync.
 */
export interface CoworkerTask {
  readonly id: string;
  readonly createdAt: string;
  readonly task: string;
  readonly assignedTo: CoworkerAssignment;
  readonly results: Partial<Record<CoworkerPersona, CoworkerPersonaResult>>;
}

export function personasFor(assignedTo: CoworkerAssignment): readonly CoworkerPersona[] {
  return assignedTo === "both" ? COWORKER_PERSONAS : [assignedTo];
}

export function createCoworkerTask(
  task: string,
  assignedTo: CoworkerAssignment,
  id: string = randomUUID(),
  createdAt: string = new Date().toISOString(),
): CoworkerTask {
  if (task.trim().length === 0) {
    throw new Error("Coworker task text must not be empty");
  }
  const results: Partial<Record<CoworkerPersona, CoworkerPersonaResult>> = {};
  for (const persona of personasFor(assignedTo)) {
    results[persona] = { status: "pending" };
  }
  return { id, createdAt, task, assignedTo, results };
}

export type CoworkerOverallStatus = "pending" | "in_progress" | "done";

/** Derived, never stored — see `CoworkerTask`'s doc comment for why. */
export function coworkerTaskOverallStatus(task: CoworkerTask): CoworkerOverallStatus {
  const statuses = personasFor(task.assignedTo).map((persona) => task.results[persona]?.status ?? "pending");
  if (statuses.every((status) => status === "succeeded" || status === "failed")) return "done";
  if (statuses.every((status) => status === "pending")) return "pending";
  return "in_progress";
}

function requireAssignedPersona(task: CoworkerTask, persona: CoworkerPersona): void {
  if (!personasFor(task.assignedTo).includes(persona)) {
    throw new Error(`Task ${task.id} is not assigned to "${persona}" (assigned to "${task.assignedTo}")`);
  }
}

/** Marks a persona's copy of the task as handed off — called once the watcher has actually sent it via `SendMessage`. */
export function withDispatched(task: CoworkerTask, persona: CoworkerPersona): CoworkerTask {
  requireAssignedPersona(task, persona);
  return {
    ...task,
    results: { ...task.results, [persona]: { status: "dispatched", dispatchedAt: new Date().toISOString() } },
  };
}

/** Records a persona's finished result — called by that persona itself once it has actually done the work. */
export function withResult(task: CoworkerTask, persona: CoworkerPersona, output: string, succeeded: boolean): CoworkerTask {
  requireAssignedPersona(task, persona);
  const previous = task.results[persona];
  return {
    ...task,
    results: {
      ...task.results,
      [persona]: {
        ...previous,
        status: succeeded ? "succeeded" : "failed",
        finishedAt: new Date().toISOString(),
        output,
      },
    },
  };
}
