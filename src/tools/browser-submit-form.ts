import type { Tool } from "./tool";
import type { FormFillingClient } from "../integrations/browser/form-client";

interface SubmitFormInput {
  readonly url: string;
  readonly values: Readonly<Record<string, string>>;
  readonly submitSelector: string;
  readonly site?: string;
}

function isSubmitFormInput(value: unknown): value is SubmitFormInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SubmitFormInput>;
  return (
    typeof v.url === "string" &&
    typeof v.values === "object" &&
    v.values !== null &&
    typeof v.submitSelector === "string" &&
    (v.site === undefined || typeof v.site === "string")
  );
}

/**
 * Consequential: the only operation in this project that clicks submit on
 * a real, external web page (ADR 0011). `requiresApproval: true` means the
 * Orchestrator never auto-executes this — it only runs via
 * approveAndExecute, after a human has matched every field exactly
 * against what browser-fill-form-preview showed them (ADR 0004's
 * exact-match pattern, same as send-email).
 */
export function createBrowserSubmitFormTool(client: FormFillingClient): Tool {
  return {
    name: "browser-submit-form",
    description:
      "Fills the given field values into a web page's form and clicks the given submit control. Consequential: only ever runs after exact-match human approval of these exact values.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        values: { type: "object" },
        submitSelector: { type: "string" },
        site: { type: "string" },
      },
      required: ["url", "values", "submitSelector"],
    },
    requiresApproval: true,
    async execute(input: unknown): Promise<string> {
      if (!isSubmitFormInput(input)) {
        throw new Error('browser-submit-form requires { "url": string, "values": {selector: string}, "submitSelector": string, "site"?: string }');
      }
      const result = await client.submitForm(input.site, input.url, input.values, input.submitSelector);
      return `submitted:true\nresultText:${result.resultText}`;
    },
  };
}
