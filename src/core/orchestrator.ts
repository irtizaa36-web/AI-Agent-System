import { randomUUID } from "node:crypto";
import type { Task } from "./task";
import type { AgentDefinition } from "./agent";
import { createSession, appendMessage } from "./session";
import type { Run, Step } from "./run";
import type { ModelProvider } from "../providers/provider";
import type { Tool } from "../tools/tool";

const DEFAULT_MAX_STEPS = 10;

export interface RunDependencies {
  readonly provider: ModelProvider;
  readonly tools: ReadonlyMap<string, Tool>;
  readonly maxSteps?: number;
}

/** Creates a queued Run for a Task, seeded with the Agent's system prompt. */
export function startRun(task: Task, agent: AgentDefinition, id: string = randomUUID()): Run {
  return {
    id,
    task,
    agentName: agent.name,
    status: "queued",
    session: createSession(agent.systemPrompt, task.instructions),
    steps: [],
  };
}

/**
 * Advances a Run by exactly one Step: one call to the Provider, plus any
 * Tool executions its response requires. Never calls the Provider or a Tool
 * directly with its own I/O — both come in via `deps`, so this function
 * stays free of I/O itself and fully testable with fakes.
 */
export async function advance(run: Run, agent: AgentDefinition, deps: RunDependencies): Promise<Run> {
  if (run.status === "succeeded" || run.status === "failed") {
    return run;
  }

  const maxSteps = deps.maxSteps ?? agent.maxSteps ?? DEFAULT_MAX_STEPS;
  if (run.steps.length >= maxSteps) {
    return {
      ...run,
      status: "failed",
      result: { status: "failed", output: "", error: `Exceeded max steps (${maxSteps})` },
    };
  }

  const toolSpecs = agent.toolNames.map((name) => {
    const tool = deps.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool "${name}" required by agent "${agent.name}"`);
    }
    return tool;
  });

  const response = await deps.provider.generate({
    model: agent.model,
    messages: run.session.messages,
    tools: toolSpecs,
  });

  let session = appendMessage(run.session, {
    role: "assistant",
    content: response.content,
    toolCalls: response.toolCalls,
  });

  const step: Step = {
    index: run.steps.length,
    responseContent: response.content,
    toolCalls: response.toolCalls,
  };
  const steps = [...run.steps, step];

  if (response.stopReason === "end_turn" || response.toolCalls.length === 0) {
    return {
      ...run,
      session,
      steps,
      status: "succeeded",
      result: { status: "succeeded", output: response.content },
    };
  }

  for (const call of response.toolCalls) {
    const tool = deps.tools.get(call.toolName);
    const content = tool
      ? String(await tool.execute(call.input))
      : `Error: unknown tool "${call.toolName}"`;
    session = appendMessage(session, { role: "tool", content, toolCallId: call.id });
  }

  return { ...run, session, steps, status: "running" };
}

/** Starts a Run and advances it until it succeeds or fails. */
export async function runToCompletion(
  task: Task,
  agent: AgentDefinition,
  deps: RunDependencies,
): Promise<Run> {
  let run: Run = { ...startRun(task, agent), status: "running" };
  while (run.status === "running") {
    run = await advance(run, agent, deps);
  }
  return run;
}
