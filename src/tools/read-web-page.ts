import type { Tool } from "./tool";
import type { BrowserClient } from "../integrations/browser/client";
import { describeFailedRead, isFailedStatus, readWithOneRetry, type ReadWithRetryOptions } from "../integrations/browser/page-health";

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
 *
 * Every result starts with a `status:` line (ADR 0026). A blocked page gets
 * one paced retry, then is reported as `blocked` — never as a page with
 * nothing on it.
 */
export function createReadWebPageTool(browserClient: BrowserClient, options: ReadWithRetryOptions = {}): Tool {
  return {
    name: "read-web-page",
    description: `Reads the rendered visible text of a web page at the given URL, using a previously-authenticated browser session for "${browserClient.siteName}". The first line is "status: ok|empty|blocked|error"; "blocked" or "error" means the page did not load, which is not the same as the page having nothing on it. Read-only: there is no way for this tool to click, type, submit a form, or change anything on the page.`,
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    async execute(input: unknown): Promise<string> {
      if (!isReadWebPageInput(input)) {
        throw new Error('read-web-page tool requires an input of the shape { "url": string }');
      }
      const result = await readWithOneRetry(browserClient, input.url, options);
      if (isFailedStatus(result.status)) {
        return `status: ${result.status}\n${describeFailedRead(input.url, result)}`;
      }
      return `status: ${result.status}\n\n${result.text ?? ""}`;
    },
  };
}
