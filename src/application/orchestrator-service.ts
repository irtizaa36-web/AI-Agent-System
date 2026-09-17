import { applyConstraints } from "../core/apply-constraints";
import { planWorkflow, runWorkflowToCompletion, type AgentResolver } from "../core/workflow-runner";
import type { Workflow } from "../core/workflow";
import { dispatchableAgents } from "../config/load";
import type { Registry } from "../registry/registry";
import { formatConstraintsForPrompt, type ConstraintsStore } from "../store/constraints-store";
import type { RunStore } from "../store/run-store";
import type { WorkflowStore } from "../store/workflow-store";
import {
  createConversationMessage,
  type Conversation,
  type ConversationMessage,
  type ConversationStore,
} from "./conversation-store";

export const PRIMARY_CONVERSATION_ID = "primary";

export interface OrchestratorServiceDeps {
  readonly registry: Registry;
  readonly runStore: RunStore;
  readonly workflowStore: WorkflowStore;
  readonly conversationStore: ConversationStore;
  readonly constraintsStore?: ConstraintsStore;
}

function resolverFor(registry: Registry, constraintsBlock: string): AgentResolver {
  return (agentName) => {
    const agent = applyConstraints(registry.getAgent(agentName), constraintsBlock);
    return {
      agent,
      deps: { provider: registry.getProvider(agent.providerName), tools: registry.toolMapFor(agent.toolNames) },
    };
  };
}

function responseFor(workflow: Workflow): Pick<ConversationMessage, "content" | "status" | "nextAction"> {
  switch (workflow.status) {
    case "succeeded":
      return {
        content: workflow.summary ?? "The delegated workflow completed successfully.",
        status: "succeeded",
        nextAction: "Review the result or give the Orchestrator a follow-up.",
      };
    case "awaiting_approval":
      return {
        content: `The workflow is paused before a consequential action. Workflow: ${workflow.id}.`,
        status: "awaiting_approval",
        nextAction: `Review the exact action with: orchestrator dispatch approve ${workflow.id}`,
      };
    case "waiting_for_response":
      return {
        content: `The workflow is waiting for an external response. Workflow: ${workflow.id}.`,
        status: "waiting_for_response",
        nextAction: `Resume it when the reply arrives with: orchestrator dispatch resume ${workflow.id} --reply "..."`,
      };
    case "failed":
      return {
        content: workflow.summary ?? workflow.planningError ?? "The workflow failed without a recorded explanation.",
        status: "failed",
        nextAction: "Review the failure, correct the request or configuration, and try again.",
      };
    default:
      return {
        content: `Workflow ${workflow.id} is ${workflow.status}.`,
        status: "failed",
        nextAction: "Inspect the workflow before continuing.",
      };
  }
}

/**
 * Application boundary shared by the dashboard and future clients. It turns
 * one natural-language message into a persisted Dispatcher workflow and real
 * registered-Agent Runs, while keeping Core free of HTTP and storage details.
 */
export class OrchestratorService {
  constructor(private readonly deps: OrchestratorServiceDeps) {}

  async getConversation(id: string = PRIMARY_CONVERSATION_ID): Promise<Conversation> {
    return (
      (await this.deps.conversationStore.load(id)) ?? {
        id,
        messages: [],
        updatedAt: new Date().toISOString(),
      }
    );
  }

  async submit(content: string, id: string = PRIMARY_CONVERSATION_ID): Promise<ConversationMessage> {
    const clean = content.trim();
    if (!clean) throw new Error('"message" must be a non-empty string');

    let conversation = await this.getConversation(id);
    const userMessage = createConversationMessage("user", clean, { status: "submitted" });
    conversation = { ...conversation, messages: [...conversation.messages, userMessage], updatedAt: userMessage.createdAt };
    await this.deps.conversationStore.save(conversation);

    try {
      const constraints = this.deps.constraintsStore ? await this.deps.constraintsStore.list() : [];
      const constraintsBlock = formatConstraintsForPrompt(constraints);
      const dispatcher = applyConstraints(this.deps.registry.getAgent("dispatcher"), constraintsBlock);
      const dispatcherDeps = {
        provider: this.deps.registry.getProvider(dispatcher.providerName),
        tools: this.deps.registry.toolMapFor(dispatcher.toolNames),
      };

      let workflow = await planWorkflow(clean, dispatcher, dispatcherDeps, dispatchableAgents(this.deps.registry));
      await this.deps.workflowStore.save(workflow);
      if (workflow.status !== "failed") {
        workflow = await runWorkflowToCompletion(workflow, resolverFor(this.deps.registry, constraintsBlock), {
          onRunUpdate: (run) => this.deps.runStore.save(run),
        });
        await this.deps.workflowStore.save(workflow);
      }

      const response = responseFor(workflow);
      const assistantMessage = createConversationMessage("assistant", response.content, {
        status: response.status,
        workflowId: workflow.id,
        nextAction: response.nextAction,
      });
      conversation = { ...conversation, messages: [...conversation.messages, assistantMessage], updatedAt: assistantMessage.createdAt };
      await this.deps.conversationStore.save(conversation);
      return assistantMessage;
    } catch (error) {
      const assistantMessage = createConversationMessage("assistant", `The Orchestrator could not start this work: ${(error as Error).message}`, {
        status: "failed",
        nextAction: "Check the local provider configuration, then retry the request.",
      });
      conversation = { ...conversation, messages: [...conversation.messages, assistantMessage], updatedAt: assistantMessage.createdAt };
      await this.deps.conversationStore.save(conversation);
      return assistantMessage;
    }
  }
}
