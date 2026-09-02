import { randomUUID } from "node:crypto";

/**
 * A unit of work submitted to the Orchestrator: intent and success criteria.
 * A Task is a spec, not an execution — see Run for the execution.
 */
export interface Task {
  readonly id: string;
  readonly instructions: string;
}

export function createTask(instructions: string, id: string = randomUUID()): Task {
  if (instructions.trim().length === 0) {
    throw new Error("Task instructions must not be empty");
  }
  return { id, instructions };
}
