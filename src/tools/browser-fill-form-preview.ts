import type { Tool } from "./tool";
import type { FormFillingClient } from "../integrations/browser/form-client";

interface FillFormPreviewInput {
  readonly url: string;
  readonly values: Readonly<Record<string, string>>;
  readonly site?: string;
}

function isFillFormPreviewInput(value: unknown): value is FillFormPreviewInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<FillFormPreviewInput>;
  return typeof v.url === "string" && typeof v.values === "object" && v.values !== null && (v.site === undefined || typeof v.site === "string");
}

/**
 * Safe: fills a form's fields and reports back what was entered, without
 * ever clicking a submit control (ADR 0011) — the write-capable
 * counterpart to inkbox-save-draft's safety model. Nothing external
 * happens until a human reviews this output and browser-submit-form is
 * separately approved.
 */
export function createBrowserFillFormPreviewTool(client: FormFillingClient): Tool {
  return {
    name: "browser-fill-form-preview",
    description:
      "Fills the given field values into a web page's form and returns the resulting values for review. Safe — never clicks submit or anything else. Use browser-list-form-fields first to find the right selectors.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        values: { type: "object" },
        site: { type: "string" },
      },
      required: ["url", "values"],
    },
    requiresApproval: false,
    async execute(input: unknown): Promise<string> {
      if (!isFillFormPreviewInput(input)) {
        throw new Error('browser-fill-form-preview requires { "url": string, "values": {selector: string}, "site"?: string }');
      }
      const fields = await client.previewFormFill(input.site, input.url, input.values);
      return JSON.stringify(fields, null, 2);
    },
  };
}
