import type { Tool } from "./tool";
import type { FormFillingClient } from "../integrations/browser/form-client";

interface ListFormFieldsInput {
  readonly url: string;
  readonly site?: string;
}

function isListFormFieldsInput(value: unknown): value is ListFormFieldsInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<ListFormFieldsInput>;
  return typeof v.url === "string" && (v.site === undefined || typeof v.site === "string");
}

/** Read-only: shows what a page's form actually looks like before anything is filled (ADR 0011). */
export function createBrowserListFormFieldsTool(client: FormFillingClient): Tool {
  return {
    name: "browser-list-form-fields",
    description:
      "Lists the fillable fields (and submit controls) found on a web page's form, so you know what a real form actually asks for before filling it. Read-only. Pass `site` if the page needs a previously-logged-in session (see `browser login`); omit it for a form that needs no login.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, site: { type: "string" } },
      required: ["url"],
    },
    async execute(input: unknown): Promise<string> {
      if (!isListFormFieldsInput(input)) {
        throw new Error('browser-list-form-fields requires { "url": string, "site"?: string }');
      }
      const fields = await client.listFormFields(input.site, input.url);
      return JSON.stringify(fields, null, 2);
    },
  };
}
