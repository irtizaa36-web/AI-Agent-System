import { parseArgs } from "node:util";
import {
  planWorkflow,
  runWorkflowToCompletion,
  approveAndContinueWorkflow,
  resumeWorkflowWithReply,
  type AgentResolver,
} from "../core/workflow-runner";
import type { Workflow } from "../core/workflow";
import { dispatchableAgents } from "../config/load";
import type { CliDeps } from "./index";

function resolverFor(deps: CliDeps): AgentResolver {
  return (agentName) => {
    const agent = deps.registry.getAgent(agentName);
    return {
      agent,
      deps: { provider: deps.registry.getProvider(agent.providerName), tools: deps.registry.toolMapFor(agent.toolNames) },
    };
  };
}

function reportWorkflowStatus(workflow: Workflow, deps: CliDeps): number {
  deps.stdout("");
  switch (workflow.status) {
    case "succeeded":
      deps.stdout(`Workflow ${workflow.id} succeeded.\n\n${workflow.summary ?? ""}`);
      return 0;
    case "failed":
      deps.stderr(`Workflow ${workflow.id} failed.\n${workflow.summary ?? workflow.planningError ?? "(no details)"}`);
      return 1;
    case "awaiting_approval":
      deps.stdout(
        `Workflow ${workflow.id} is paused: step ${workflow.currentStepIndex + 1} (${workflow.steps[workflow.currentStepIndex].agentName}) ` +
          `needs approval. Run \`orchestrator dispatch approve ${workflow.id}\` to review it.`,
      );
      return 0;
    case "waiting_for_response":
      deps.stdout(
        `Workflow ${workflow.id} is paused: step ${workflow.currentStepIndex + 1} (${workflow.steps[workflow.currentStepIndex].agentName}) ` +
          `is waiting for an external reply. Run \`orchestrator dispatch resume ${workflow.id} --reply "..."\` once you have it.`,
      );
      return 0;
    default:
      deps.stdout(`Workflow ${workflow.id} status: ${workflow.status}`);
      return 0;
  }
}

/** `dispatch run --task "<goal>"`: plan the goal with the Dispatcher agent, then execute the plan step by step (ADR 0008). */
async function runCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...args], options: { task: { type: "string" } }, allowPositionals: true });
  const goal = values.task ?? positionals[0];
  if (!goal) {
    deps.stderr('Usage: orchestrator dispatch run --task "<goal>"');
    return 1;
  }

  const dispatcher = deps.registry.getAgent("dispatcher");
  const dispatcherDeps = { provider: deps.registry.getProvider(dispatcher.providerName), tools: deps.registry.toolMapFor(dispatcher.toolNames) };
  const availableAgents = dispatchableAgents(deps.registry);

  deps.stdout(`Planning how to accomplish: "${goal}"...`);
  let workflow = await planWorkflow(goal, dispatcher, dispatcherDeps, availableAgents);
  await deps.workflowStore.save(workflow);

  if (workflow.status === "failed") {
    deps.stderr(`Planning failed: ${workflow.planningError}`);
    return 1;
  }

  deps.stdout(`Plan (workflow ${workflow.id}):`);
  workflow.steps.forEach((step, index) => deps.stdout(`  ${index + 1}. [${step.agentName}] ${step.instructions}`));

  workflow = await runWorkflowToCompletion(workflow, resolverFor(deps), { onRunUpdate: (run) => deps.store.save(run) });
  await deps.workflowStore.save(workflow);

  return reportWorkflowStatus(workflow, deps);
}

async function statusCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const [id] = args;
  if (!id) {
    deps.stderr("Usage: orchestrator dispatch status <workflow-id>");
    return 1;
  }
  const workflow = await deps.workflowStore.load(id);
  if (!workflow) {
    deps.stderr(`No workflow "${id}" found.`);
    return 1;
  }
  return reportWorkflowStatus(workflow, deps);
}

/** `dispatch approve <workflow-id> [--yes]`: reviews (and, with --yes, confirms verbatim) the currently pending gated action for the paused step. */
async function approveCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...args], options: { yes: { type: "boolean" } }, allowPositionals: true });
  const id = positionals[0];
  if (!id) {
    deps.stderr("Usage: orchestrator dispatch approve <workflow-id> [--yes]");
    return 1;
  }

  const workflow = await deps.workflowStore.load(id);
  if (!workflow) {
    deps.stderr(`No workflow "${id}" found.`);
    return 1;
  }
  if (workflow.status !== "awaiting_approval") {
    deps.stderr(`Workflow "${id}" is not awaiting approval (status: ${workflow.status}).`);
    return 1;
  }

  const step = workflow.steps[workflow.currentStepIndex];
  const run = step.runId ? await deps.store.load(step.runId) : undefined;
  if (!run?.pendingAction) {
    deps.stderr(`Workflow "${id}"'s current step has no pending action to approve.`);
    return 1;
  }

  deps.stdout(`Step ${workflow.currentStepIndex + 1} (${step.agentName}) wants to call "${run.pendingAction.toolName}" with:`);
  deps.stdout(JSON.stringify(run.pendingAction.input, null, 2));

  if (!values.yes) {
    deps.stdout(`\nReview the input above. Re-run with --yes to approve it exactly as shown.`);
    return 0;
  }

  const agent = deps.registry.getAgent(run.agentName);
  const tools = deps.registry.toolMapFor(agent.toolNames);
  const updated = await approveAndContinueWorkflow(workflow, run, { tools }, run.pendingAction.input, { onRunUpdate: (r) => deps.store.save(r) });
  await deps.workflowStore.save(updated);

  return reportWorkflowStatus(updated, deps);
}

/** `dispatch resume <workflow-id> --reply "..."`: delivers an external reply to the paused step, then continues the remaining steps. */
async function resumeCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...args], options: { reply: { type: "string" } }, allowPositionals: true });
  const id = positionals[0];
  if (!id || !values.reply) {
    deps.stderr('Usage: orchestrator dispatch resume <workflow-id> --reply "<text>"');
    return 1;
  }

  const workflow = await deps.workflowStore.load(id);
  if (!workflow) {
    deps.stderr(`No workflow "${id}" found.`);
    return 1;
  }
  if (workflow.status !== "waiting_for_response") {
    deps.stderr(`Workflow "${id}" is not waiting for a response (status: ${workflow.status}).`);
    return 1;
  }

  const step = workflow.steps[workflow.currentStepIndex];
  const run = step.runId ? await deps.store.load(step.runId) : undefined;
  if (!run) {
    deps.stderr(`Workflow "${id}"'s current step has no run to resume.`);
    return 1;
  }

  const agent = deps.registry.getAgent(run.agentName);
  const runDeps = { provider: deps.registry.getProvider(agent.providerName), tools: deps.registry.toolMapFor(agent.toolNames) };
  const updated = await resumeWorkflowWithReply(workflow, run, agent, runDeps, values.reply, resolverFor(deps), {
    onRunUpdate: (r) => deps.store.save(r),
  });
  await deps.workflowStore.save(updated);

  return reportWorkflowStatus(updated, deps);
}

export async function runDispatchCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "run":
      return runCommand(rest, deps);
    case "status":
      return statusCommand(rest, deps);
    case "approve":
      return approveCommand(rest, deps);
    case "resume":
      return resumeCommand(rest, deps);
    default:
      deps.stderr('Usage: orchestrator dispatch run --task "<goal>" | status <id> | approve <id> [--yes] | resume <id> --reply "<text>"');
      return 1;
  }
}
