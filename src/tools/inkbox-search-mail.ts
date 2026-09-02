import type { Tool } from "./tool";
import type { InkboxClient } from "../integrations/inkbox/client";

/** Read-only: lists or searches the Inkbox mailbox. Never consequential, no approval needed. */
export function createInkboxSearchMailTool(client: InkboxClient): Tool {
  return {
    name: "inkbox-search-mail",
    description: "Searches or lists mail in the Inkbox mailbox. Read-only.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
    async execute(input: unknown): Promise<string> {
      const query = isRecord(input) && typeof input.query === "string" ? input.query : undefined;
      const messages = await client.searchMail(query);
      if (messages.length === 0) return "No matching mail found.";
      return messages
        .map(
          (m) =>
            `id:${m.id}\nthreadId:${m.threadId}\nfrom:${m.from.address}\nsubject:${m.subject}\nreceivedAt:${m.receivedAt}`,
        )
        .join("\n---\n");
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
