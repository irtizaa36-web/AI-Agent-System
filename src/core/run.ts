import type { Task } from "./task";
import type { Session, ToolCall } from "./session";

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

/** One model turn within a Run: a response, and any Tool Calls it produced. */
export interface Step {
  readonly index: number;
  readonly responseContent: string;
  readonly toolCalls: readonly ToolCall[];
}

/** The final output of a Run. */
export interface Result {
  readonly status: "succeeded" | "failed";
  readonly output: string;
  readonly error?: string;
}

/** One execution of a Task by an Agent. */
export interface Run {
  readonly id: string;
  readonly task: Task;
  readonly agentName: string;
  readonly status: RunStatus;
  readonly session: Session;
  readonly steps: readonly Step[];
  readonly result?: Result;
}
