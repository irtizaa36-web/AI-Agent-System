import type { Tool } from "./tool";
import type { EmailAddress, InkboxClient } from "../integrations/inkbox/client";
import { isEmailAddressArray } from "../integrations/inkbox/client";
import { computeOutboundBcc } from "../integrations/inkbox/owner-forwarding";

interface SaveDraftInput {
  readonly to: readonly EmailAddress[];
  readonly subject: string;
  readonly body: string;
  readonly threadId?: string;
  readonly draftId?: string;
}

function isSaveDraftInput(value: unknown): value is SaveDraftInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SaveDraftInput>;
  return isEmailAddressArray(v.to) && v.to.length > 0 && typeof v.subject === "string" && typeof v.body === "string";
}

/**
 * Saves (or updates) an email draft. Safe — a draft never gets delivered to
 * anyone. The owner's BCC is computed here, at draft time, so it's already
 * part of what a human reviews before ever approving a send.
 */
export function createInkboxSaveDraftTool(client: InkboxClient): Tool {
  return {
    name: "inkbox-save-draft",
    description: "Saves or updates an email draft in the Inkbox Drafts folder. Safe — never sends anything.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "object" } },
        subject: { type: "string" },
        body: { type: "string" },
        threadId: { type: "string" },
        draftId: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
    requiresApproval: false,
    async execute(input: unknown): Promise<string> {
      if (!isSaveDraftInput(input)) {
        throw new Error(
          'inkbox-save-draft requires { "to": [{"address": string}], "subject": string, "body": string }',
        );
      }
      const bcc = computeOutboundBcc(input.to, [], client.mailboxAddress);
      const draft = await client.saveDraft({
        to: input.to,
        subject: input.subject,
        body: input.body,
        bcc,
        threadId: input.threadId,
        draftId: input.draftId,
      });
      return [
        `draftId:${draft.id}`,
        `revision:${draft.revision}`,
        `to:${draft.to.map((a) => a.address).join(", ")}`,
        `bcc:${(draft.bcc ?? []).map((a) => a.address).join(", ") || "(none)"}`,
        `subject:${draft.subject}`,
        `body:${draft.body}`,
      ].join("\n");
    },
  };
}
