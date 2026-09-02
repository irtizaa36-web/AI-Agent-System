import type { Tool } from "./tool";
import type { BrowserClient } from "../integrations/browser/client";

interface ReadWebPageInput {
  readonly url: string;
}

function isReadWebPageInput(input: unknown): input is ReadWebPageInput {
  return typeof input === "object" && input !== null && typeof (input as { url?: unknown }).url === "string";
}

/**
 * Reads the rendered visible text of an authenticated page (ADR 0007).
 * Read-only by construction — BrowserClient has no click/type/submit
 * operation for this Tool to expose even if an agent were instructed to
 * use one.
 */
export function createReadWebPageTool(browserClient: BrowserClient): Tool {
  return {
    name: "read-web-page",
    description: `Reads the rendered visible text of a web page at the given URL, using a previously-authenticated browser session for "${browserClient.siteName}". Read-only: there is no way for this tool to click, type, submit a form, or change anything on the page.`,
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    async execute(input: unknown): Promise<string> {
      if (!isReadWebPageInput(input)) {
        throw new Error('read-web-page tool requires an input of the shape { "url": string }');
      }
      return browserClient.getPageText(input.url);
    },
  };
}
