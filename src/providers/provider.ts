import type { Message, ToolCall } from "../core/session";
import type { ToolSpec } from "../tools/tool";

export interface GenerateRequest {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
}

export interface GenerateResult {
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly stopReason: "end_turn" | "tool_use";
}

/**
 * An adapter that speaks one model vendor's API and exposes it through this
 * generic interface. This is the seam that makes the Orchestrator
 * model-agnostic: Core only ever depends on this interface, never on a
 * vendor SDK directly.
 */
export interface ModelProvider {
  readonly name: string;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}
