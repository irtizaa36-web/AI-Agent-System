import type { Tool } from "./tool";
import type { EmailAddress, InkboxClient } from "../integrations/inkbox/client";

interface SendEmailInput {
  readonly to: readonly EmailAddress[];
  readonly subject: string;
  readonly body: string;
  readonly bcc: readonly EmailAddress[];
  readonly draftId: string;
  readonly revision: string;
}

function isSendEmailInput(value: unknown): value is SendEmailInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SendEmailInput>;
  return (
    Array.isArray(v.to) &&
    typeof v.subject === "string" &&
    typeof v.body === "string" &&
    Array.isArray(v.bcc) &&
    typeof v.draftId === "string" &&
    typeof v.revision === "string"
  );
}

function sameAddresses(a: readonly EmailAddress[], b: readonly EmailAddress[]): boolean {
  return JSON.stringify(a.map((x) => x.address).sort()) === JSON.stringify(b.map((x) => x.address).sort());
}

/**
 * The strictly separate, consequential counterpart to inkbox-save-draft.
 * `requiresApproval: true` means the Orchestrator never auto-executes this
 * (ADR 0004) — it only ever runs via `approveAndExecute`, after a human has
 * matched every field exactly. This tool re-checks the live draft as a
 * second, independent line of defense beyond that approval match.
 */
export function createSendEmailTool(client: InkboxClient): Tool {
  return {
    name: "send-email",
    description: "Sends an email draft. Consequential: only ever runs after exact-match human approval.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "object" } },
        subject: { type: "string" },
        body: { type: "string" },
        bcc: { type: "array", items: { type: "object" } },
        draftId: { type: "string" },
        revision: { type: "string" },
      },
      required: ["to", "subject", "body", "bcc", "draftId", "revision"],
    },
    requiresApproval: true,
    async execute(input: unknown): Promise<string> {
      if (!isSendEmailInput(input)) {
        throw new Error(
          'send-email requires { "to": [...], "subject": string, "body": string, "bcc": [...], ' +
            '"draftId": string, "revision": string }',
        );
      }

      const draft = await client.getDraft(input.draftId);
      if (!draft) {
        throw new Error(`No draft "${input.draftId}" found to send`);
      }
      const matchesLiveDraft =
        draft.revision === input.revision &&
        draft.subject === input.subject &&
        draft.body === input.body &&
        sameAddresses(draft.to, input.to) &&
        sameAddresses(draft.bcc ?? [], input.bcc);
      if (!matchesLiveDraft) {
        throw new Error(
          `Draft "${input.draftId}" no longer matches what was approved (current revision "${draft.revision}"); ` +
            "re-review the draft before sending.",
        );
      }

      const result = await client.send({ draftId: input.draftId, revision: input.revision });
      return [
        "sent:true",
        `messageId:${result.messageId}`,
        `threadId:${result.threadId}`,
        `to:${result.to.map((a) => a.address).join(", ")}`,
        `bcc:${result.bcc.map((a) => a.address).join(", ") || "(none)"}`,
        `sentAt:${result.sentAt}`,
      ].join("\n");
    },
  };
}
