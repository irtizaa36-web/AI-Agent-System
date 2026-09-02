import { createTask } from "./task";
import type { AgentDefinition } from "./agent";
import type { Run } from "./run";
import { runToCompletion, approveAndExecute, resumeWithReply, type RunDependencies } from "./orchestrator";
import { createWorkflow, createFailedWorkflow, parseWorkflowPlan, type Workflow, type WorkflowStep } from "./workflow";

/** What the Dispatcher agent is told about one candidate agent, so it can route a goal to it. */
export interface AvailableAgent {
  readonly name: string;
  readonly description: string;
}

/** Resolves the Agent definition and run dependencies (Provider, Tools) for one workflow step, by agent name. Supplied by the caller (the CLI), never looked up by Core itself — Core stays free of Registry/I/O. */
export type AgentResolver = (agentName: string) => { readonly agent: AgentDefinition; readonly deps: RunDependencies };

export interface WorkflowRunHooks {
  /** Called whenever a step's underlying Run is created or changes, so the caller can persist it (e.g. to RunStore) as it happens — the only way a paused step stays resumable across process restarts. */
  readonly onRunUpdate?: (run: Run) => Promise<void> | void;
}

function buildDispatcherTask(goal: string, availableAgents: readonly AvailableAgent[]) {
  const agentList = availableAgents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
  return createTask(
    `A user stated this goal in plain English:\n"${goal}"\n\n` +
      `Available agents:\n${agentList}\n\n` +
      "Plan the ordered steps needed to accomplish this goal using only the agents listed above.",
  );
}

/**
 * Runs the Dispatcher agent once to turn a plain-English goal into an
 * ordered Workflow (ADR 0008). Planning is itself a Run — the Dispatcher is
 * an ordinary Agent with no Tools, so this reuses runToCompletion exactly
 * like any other Agent invocation, rather than a special-cased code path.
 */
export async function planWorkflow(
  goal: string,
  dispatcherAgent: AgentDefinition,
  dispatcherDeps: RunDependencies,
  availableAgents: readonly AvailableAgent[],
): Promise<Workflow> {
  const task = buildDispatcherTask(goal, availableAgents);
  const run = await runToCompletion(task, dispatcherAgent, dispatcherDeps);

  if (run.status !== "succeeded") {
    return createFailedWorkflow(goal, `Dispatcher run did not succeed (status: ${run.status}): ${run.result?.error ?? "unknown error"}`);
  }

  const parsed = parseWorkflowPlan(run.result?.output ?? "", availableAgents.map((a) => a.name));
  if (!parsed.ok) {
    return createFailedWorkflow(goal, parsed.reason);
  }
  return createWorkflow(goal, parsed.steps);
}

function summarize(steps: readonly WorkflowStep[], outputs: ReadonlyMap<number, string>): string {
  return steps
    .map((step, index) => {
      const label = `Step ${index + 1} — ${step.agentName} (${step.status})`;
      const output = outputs.get(index);
      if (output !== undefined) return `${label}:\n${output}`;
      return step.runId ? `${label} (see run ${step.runId})` : label;
    })
    .join("\n\n");
}

/**
 * Executes workflow.steps in order starting at `startIndex`, threading each
 * succeeded step's output into the next step's instructions as context.
 * Stops early — without touching later steps — the moment a step's Run
 * pauses (`awaiting_approval`/`waiting_for_response`) or fails, mirroring
 * how a single Run pauses on a gated Tool (ADR 0004) rather than guessing
 * at how to proceed.
 */
async function runStepsFrom(
  workflow: Workflow,
  resolve: AgentResolver,
  startIndex: number,
  initialContext: string | undefined,
  hooks: WorkflowRunHooks,
): Promise<Workflow> {
  const steps = [...workflow.steps];
  const outputs = new Map<number, string>();
  let previousOutput = initialContext;

  for (let index = startIndex; index < steps.length; index++) {
    const step = steps[index];
    const { agent, deps } = resolve(step.agentName);
    const instructions = previousOutput
      ? `${step.instructions}\n\nContext from the previous step ("${steps[index - 1].agentName}"):\n${previousOutput}`
      : step.instructions;

    steps[index] = { ...step, status: "running" };
    const run = await runToCompletion(createTask(instructions), agent, deps);
    await hooks.onRunUpdate?.(run);
    steps[index] = { ...steps[index], runId: run.id };

    if (run.status === "succeeded") {
      previousOutput = run.result?.output ?? "";
      outputs.set(index, previousOutput);
      steps[index] = { ...steps[index], status: "succeeded" };
      continue;
    }

    if (run.status === "awaiting_approval" || run.status === "waiting_for_response") {
      return { ...workflow, steps, currentStepIndex: index, status: run.status };
    }

    steps[index] = { ...steps[index], status: "failed" };
    if (run.result?.error) outputs.set(index, run.result.error);
    return {
      ...workflow,
      steps,
      currentStepIndex: index,
      status: "failed",
      completedAt: new Date().toISOString(),
      summary: summarize(steps, outputs),
    };
  }

  return {
    ...workflow,
    steps,
    currentStepIndex: steps.length - 1,
    status: "succeeded",
    completedAt: new Date().toISOString(),
    summary: summarize(steps, outputs),
  };
}

/** Runs every step of a freshly-planned Workflow (currentStepIndex 0, no runId yet) to completion or its first pause/failure. */
export async function runWorkflowToCompletion(workflow: Workflow, resolve: AgentResolver, hooks: WorkflowRunHooks = {}): Promise<Workflow> {
  return runStepsFrom(workflow, resolve, workflow.currentStepIndex, undefined, hooks);
}

/**
 * Approves the current step's pending gated action (same exact-match rule
 * as approveAndExecute) and continues. Approval always lands the underlying
 * Run on `waiting_for_response` (see orchestrator.ts) — the workflow mirrors
 * that status, so a subsequent `resumeWorkflowWithReply` is what actually
 * moves on to the next step once a real reply arrives.
 */
export async function approveAndContinueWorkflow(
  workflow: Workflow,
  pausedRun: Run,
  deps: Pick<RunDependencies, "tools">,
  approvalInput: Record<string, unknown>,
  hooks: WorkflowRunHooks = {},
): Promise<Workflow> {
  if (workflow.status !== "awaiting_approval") {
    throw new Error(`Workflow "${workflow.id}" is not awaiting approval (status: ${workflow.status})`);
  }
  const approvedRun = await approveAndExecute(pausedRun, deps, approvalInput);
  await hooks.onRunUpdate?.(approvedRun);

  const steps = [...workflow.steps];
  const index = workflow.currentStepIndex;
  steps[index] = { ...steps[index], runId: approvedRun.id };
  // approveAndExecute always lands on "waiting_for_response" — see its own doc comment in orchestrator.ts.
  return { ...workflow, steps, status: "waiting_for_response" };
}

/** Resumes the current step's Run with an external reply, then — if it succeeds — continues executing the remaining steps. */
export async function resumeWorkflowWithReply(
  workflow: Workflow,
  pausedRun: Run,
  agent: AgentDefinition,
  deps: RunDependencies,
  replyContent: string,
  resolve: AgentResolver,
  hooks: WorkflowRunHooks = {},
): Promise<Workflow> {
  if (workflow.status !== "waiting_for_response") {
    throw new Error(`Workflow "${workflow.id}" is not waiting for a response (status: ${workflow.status})`);
  }
  const resumedRun = await resumeWithReply(pausedRun, agent, deps, replyContent);
  await hooks.onRunUpdate?.(resumedRun);

  const index = workflow.currentStepIndex;
  const steps = [...workflow.steps];
  steps[index] = { ...steps[index], runId: resumedRun.id };

  if (resumedRun.status === "succeeded") {
    steps[index] = { ...steps[index], status: "succeeded" };
    return runStepsFrom({ ...workflow, steps }, resolve, index + 1, resumedRun.result?.output ?? "", hooks);
  }
  if (resumedRun.status === "awaiting_approval" || resumedRun.status === "waiting_for_response") {
    return { ...workflow, steps, status: resumedRun.status };
  }
  steps[index] = { ...steps[index], status: "failed" };
  return { ...workflow, steps, status: "failed", completedAt: new Date().toISOString() };
}
