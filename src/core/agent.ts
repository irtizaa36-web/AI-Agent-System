/**
 * A configured persona: a role, a Model (via a named Provider), and the
 * Tools it may use. An AgentDefinition is a definition, not a running thing.
 */
export interface AgentDefinition {
  readonly name: string;
  readonly providerName: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly toolNames: readonly string[];
  readonly maxSteps?: number;
  /** A one-line, plain-English summary of what this agent is for — used by the Dispatcher agent to route a task to it (see workflow.ts). Optional so existing agents keep working without one. */
  readonly description?: string;
}
