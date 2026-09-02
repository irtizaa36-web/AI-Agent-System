import type { Task } from "./task";
import type { Session, ToolCall } from "./session";

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

/** One model turn within a Run: a response, and any Tool Calls it produced. */
export interface Step {
  readonly index: number;
  readonly occurredAt: string;
  readonly responseContent: string;
  readonly toolCalls: readonly ToolCall[];
}

/** The final output of a Run. */
export interface Result {
  readonly status: "succeeded" | "failed";
  readonly output: string;
  readonly error?: string;
}

/**
 * One execution of a Task by an Agent. `createdAt`/`completedAt` exist for
 * audit history: once Tools can take real-world action, knowing *when* a
 * Run happened is part of the record, not an optional extra.
 */
export interface Run {
  readonly id: string;
  readonly task: Task;
  readonly agentName: string;
  readonly status: RunStatus;
  readonly session: Session;
  readonly steps: readonly Step[];
  readonly result?: Result;
  readonly createdAt: string;
  readonly completedAt?: string;
}
