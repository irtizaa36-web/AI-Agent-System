import type { Task } from "./task";
import type { Session, ToolCall } from "./session";

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "waiting_for_response"
  | "succeeded"
  | "failed";

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
 * A Tool call a Run has proposed but not executed, because the Tool is
 * marked `requiresApproval`. Generic on purpose (ADR 0005): Core knows
 * only "a named Tool wants to run with this input," never what an email or
 * a reservation is. `input` is exactly what a human must review and
 * re-supply, unchanged, for `approveAndExecute` to proceed.
 */
export interface PendingAction {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Record<string, unknown>;
  readonly summary: string;
  readonly requestedAt: string;
}

/**
 * One execution of a Task by an Agent. `createdAt`/`completedAt` exist for
 * audit history: once Tools can take real-world action, knowing *when* a
 * Run happened is part of the record, not an optional extra. `pendingAction`
 * and `threadId` exist for the same reason `awaiting_approval` and
 * `waiting_for_response` do: a Run can now pause on a real consequential
 * action and later resume from an external reply.
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
  readonly pendingAction?: PendingAction;
  /** Set once a gated action succeeds, so a later reply can be matched back to this Run. */
  readonly threadId?: string;
}
