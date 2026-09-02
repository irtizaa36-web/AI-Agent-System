import { randomUUID } from "node:crypto";

export type WorkflowStatus =
  | "planning"
  | "running"
  | "awaiting_approval"
  | "waiting_for_response"
  | "succeeded"
  | "failed";

/** One planned step: which Agent handles it, and the instructions for its Task. Filled in with a runId once executed. */
export interface WorkflowStep {
  readonly agentName: string;
  readonly instructions: string;
  readonly runId?: string;
  readonly status: "pending" | "running" | "succeeded" | "failed";
}

/**
 * A goal stated in plain English, broken into an ordered sequence of Runs
 * across one or more Agents (ADR 0008). Each step is a real Run persisted
 * in the existing RunStore — a Workflow is the record of how those Runs
 * chain together, not a replacement for Run/Result.
 */
export interface Workflow {
  readonly id: string;
  readonly goal: string;
  readonly steps: readonly WorkflowStep[];
  readonly currentStepIndex: number;
  readonly status: WorkflowStatus;
  readonly createdAt: string;
  readonly completedAt?: string;
  /** Set once every step has run: a plain-English report of what happened, in the order it happened. */
  readonly summary?: string;
  /** Set when planning fails outright (e.g. no available agent fits, or the Dispatcher's output couldn't be parsed). */
  readonly planningError?: string;
}

export function createWorkflow(goal: string, steps: readonly Omit<WorkflowStep, "status">[], id: string = randomUUID()): Workflow {
  if (steps.length === 0) {
    return createFailedWorkflow(goal, "The Dispatcher planned zero steps for this goal.", id);
  }
  return {
    id,
    goal,
    steps: steps.map((step) => ({ ...step, status: "pending" })),
    currentStepIndex: 0,
    status: "running",
    createdAt: new Date().toISOString(),
  };
}

/** A Workflow that never got to run at all, because planning itself failed (a bad Dispatcher response, or zero usable steps). */
export function createFailedWorkflow(goal: string, planningError: string, id: string = randomUUID()): Workflow {
  const now = new Date().toISOString();
  return { id, goal, steps: [], currentStepIndex: 0, status: "failed", createdAt: now, completedAt: now, planningError };
}

export type ParsedWorkflowPlan =
  | { readonly ok: true; readonly steps: readonly { readonly agentName: string; readonly instructions: string }[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Parses the Dispatcher agent's plain-text response into an ordered list of
 * steps. The Dispatcher is instructed to reply with exactly one fenced
 * ```json code block containing an array of `{"agent": ..., "task": ...}`
 * objects — this is deliberately a plain-text convention rather than a Tool
 * call, since the Dispatcher itself has no Tools (it only ever plans, never
 * acts). Every `agent` name must be one this caller actually has available;
 * an unrecognized name fails the whole plan rather than silently dropping
 * a step, since a step that can never run would otherwise fail invisibly
 * partway through execution instead of at planning time.
 */
export function parseWorkflowPlan(responseText: string, availableAgentNames: readonly string[]): ParsedWorkflowPlan {
  const match = responseText.match(/```json\s*([\s\S]*?)```/);
  if (!match) {
    return { ok: false, reason: "Dispatcher response did not contain a fenced ```json plan block." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1] ?? "");
  } catch (error) {
    return { ok: false, reason: `Dispatcher plan block is not valid JSON: ${(error as Error).message}` };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "Dispatcher plan block must be a JSON array of steps." };
  }

  const steps: { agentName: string; instructions: string }[] = [];
  for (const [index, raw] of parsed.entries()) {
    const entry = raw as Record<string, unknown>;
    const agentName = typeof entry["agent"] === "string" ? entry["agent"] : undefined;
    const instructions = typeof entry["task"] === "string" ? entry["task"] : undefined;
    if (!agentName || !instructions) {
      return { ok: false, reason: `Step ${index} must have string "agent" and "task" fields.` };
    }
    if (!availableAgentNames.includes(agentName)) {
      return { ok: false, reason: `Step ${index} names unknown agent "${agentName}". Available: ${availableAgentNames.join(", ")}.` };
    }
    steps.push({ agentName, instructions });
  }

  return { ok: true, steps };
}
