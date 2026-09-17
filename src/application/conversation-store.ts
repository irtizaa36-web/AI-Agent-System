import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isNotFoundError } from "../store/run-store";

export type ConversationMessageRole = "user" | "assistant";
export type ConversationMessageStatus =
  | "submitted"
  | "succeeded"
  | "failed"
  | "awaiting_approval"
  | "waiting_for_response";

export interface ConversationMessage {
  readonly id: string;
  readonly role: ConversationMessageRole;
  readonly content: string;
  readonly createdAt: string;
  readonly status?: ConversationMessageStatus;
  readonly workflowId?: string;
  readonly nextAction?: string;
}

export interface Conversation {
  readonly id: string;
  readonly messages: readonly ConversationMessage[];
  readonly updatedAt: string;
}

export interface ConversationStore {
  load(id: string): Promise<Conversation | undefined>;
  save(conversation: Conversation): Promise<void>;
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, Conversation>();

  async load(id: string): Promise<Conversation | undefined> {
    return this.conversations.get(id);
  }

  async save(conversation: Conversation): Promise<void> {
    this.conversations.set(conversation.id, conversation);
  }
}

/** Persists the single-user conversation outside Git, using an atomic replace. */
export class JsonFileConversationStore implements ConversationStore {
  constructor(private readonly path: string) {}

  async load(id: string): Promise<Conversation | undefined> {
    try {
      const raw = await readFile(this.path, "utf-8");
      const conversation = JSON.parse(raw) as Conversation;
      return conversation.id === id ? conversation : undefined;
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      throw error;
    }
  }

  async save(conversation: Conversation): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(conversation, null, 2), { encoding: "utf-8", flag: "wx" });
    await rename(temporary, this.path);
  }
}

export function createConversationMessage(
  role: ConversationMessageRole,
  content: string,
  details: Pick<ConversationMessage, "status" | "workflowId" | "nextAction"> = {},
): ConversationMessage {
  return { id: randomUUID(), role, content, createdAt: new Date().toISOString(), ...details };
}
