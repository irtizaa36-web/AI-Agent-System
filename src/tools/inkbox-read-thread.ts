import type { Tool } from "./tool";
import type { InkboxClient } from "../integrations/inkbox/client";

/** Read-only: reads a complete email thread by id. Never consequential, no approval needed. */
export function createInkboxReadThreadTool(client: InkboxClient): Tool {
  return {
    name: "inkbox-read-thread",
    description: "Reads a complete email thread, including every message in it, by thread id. Read-only.",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
    },
    async execute(input: unknown): Promise<string> {
      const threadId = isRecord(input) && typeof input.threadId === "string" ? input.threadId : undefined;
      if (!threadId) {
        throw new Error('inkbox-read-thread requires an input of the shape { "threadId": string }');
      }
      const thread = await client.readThread(threadId);
      if (!thread) return `No thread found with id "${threadId}".`;
      return [
        `threadId:${thread.id}`,
        `subject:${thread.subject}`,
        ...thread.messages.map(
          (m) => `--- message ${m.id} from ${m.from.address} at ${m.receivedAt} ---\n${m.body}`,
        ),
      ].join("\n");
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
