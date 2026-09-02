import { randomUUID } from "node:crypto";
import type { Task } from "./task";
import type { AgentDefinition } from "./agent";
import { createSession, appendMessage } from "./session";
import type { PendingAction, Run, Step } from "./run";
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
    createdAt: new Date().toISOString(),
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
      completedAt: new Date().toISOString(),
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
    occurredAt: new Date().toISOString(),
    responseContent: response.content,
    toolCalls: response.toolCalls,
  };
  const steps = [...run.steps, step];

  // A truncated response is never a usable final answer — treating it as a
  // success would silently hand back a cut-off draft (e.g. a personal
  // statement stopping mid-sentence) with nothing to say it's incomplete.
  if (response.stopReason === "max_tokens") {
    return {
      ...run,
      session,
      steps,
      status: "failed",
      result: {
        status: "failed",
        output: "",
        error: `Model response was truncated (hit the max_tokens limit) before finishing. Raise the provider's maxTokens or shorten the task and try again.`,
      },
      completedAt: new Date().toISOString(),
    };
  }

  if (response.stopReason === "end_turn" || response.toolCalls.length === 0) {
    return {
      ...run,
      session,
      steps,
      status: "succeeded",
      result: { status: "succeeded", output: response.content },
      completedAt: new Date().toISOString(),
    };
  }

  // A Tool marked requiresApproval never auto-executes (ADR 0004). If any
  // requested call needs approval, the whole step pauses on the first one —
  // the assistant's proposal is recorded, but nothing runs, until a human
  // calls approveAndExecute with the exact same input.
  const gatedCall = response.toolCalls.find((call) => deps.tools.get(call.toolName)?.requiresApproval);
  if (gatedCall) {
    const pendingAction: PendingAction = {
      toolName: gatedCall.toolName,
      toolCallId: gatedCall.id,
      input: (gatedCall.input ?? {}) as Record<string, unknown>,
      summary: `Agent "${agent.name}" wants to call "${gatedCall.toolName}"`,
      requestedAt: new Date().toISOString(),
    };
    return { ...run, session, steps, status: "awaiting_approval", pendingAction };
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

/** Starts a Run and advances it until it succeeds, fails, or pauses. */
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

/**
 * Approves and executes a Run's pending gated action. Rejects — without
 * touching the Run — unless `approvalInput` is deeply, exactly equal to
 * `run.pendingAction.input`: a changed recipient, subject, body, or
 * revision means the approval no longer matches what's pending, and must
 * be re-reviewed rather than silently accepted.
 */
export async function approveAndExecute(
  run: Run,
  deps: Pick<RunDependencies, "tools">,
  approvalInput: Record<string, unknown>,
): Promise<Run> {
  if (run.status !== "awaiting_approval" || !run.pendingAction) {
    throw new Error(`Run "${run.id}" is not awaiting approval (status: ${run.status})`);
  }
  if (!deepEqual(run.pendingAction.input, approvalInput)) {
    throw new Error(
      `Approval does not match the pending action for run "${run.id}". The draft or recipients may have ` +
        "changed since this was staged — review the current pending action and try again.",
    );
  }

  const tool = deps.tools.get(run.pendingAction.toolName);
  if (!tool) {
    throw new Error(`Unknown tool "${run.pendingAction.toolName}" pending approval on run "${run.id}"`);
  }

  const content = String(await tool.execute(run.pendingAction.input));
  const session = appendMessage(run.session, { role: "tool", content, toolCallId: run.pendingAction.toolCallId });
  const threadId = extractThreadId(content);

  return {
    ...run,
    session,
    status: "waiting_for_response",
    pendingAction: undefined,
    ...(threadId ? { threadId } : {}),
  };
}

/**
 * Resumes a Run that was waiting for an external reply: appends the reply
 * as a new message and continues the Step loop from there, same as
 * runToCompletion does from the start.
 */
export async function resumeWithReply(run: Run, agent: AgentDefinition, deps: RunDependencies, replyContent: string): Promise<Run> {
  if (run.status !== "waiting_for_response") {
    throw new Error(`Run "${run.id}" is not waiting for a response (status: ${run.status})`);
  }

  let resumed: Run = {
    ...run,
    status: "running",
    session: appendMessage(run.session, { role: "user", content: `External reply received:\n${replyContent}` }),
  };
  while (resumed.status === "running") {
    resumed = await advance(resumed, agent, deps);
  }
  return resumed;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, sortKeysDeep(v)]),
    );
  }
  return value;
}

/** Tool results that record a thread id (our Inkbox tools do) encode it as `threadId:<value>` on its own line. */
function extractThreadId(toolResultContent: string): string | undefined {
  return toolResultContent.match(/^threadId:(\S+)$/m)?.[1];
}
