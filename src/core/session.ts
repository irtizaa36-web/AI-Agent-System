/**
 * The accumulated message history for a Run, carried across Steps and
 * handed to the Model each time.
 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  readonly id: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface Message {
  readonly role: MessageRole;
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
}

export interface Session {
  readonly messages: readonly Message[];
}

export function createSession(systemPrompt: string, userMessage: string): Session {
  return {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  };
}

export function appendMessage(session: Session, message: Message): Session {
  return { messages: [...session.messages, message] };
}
