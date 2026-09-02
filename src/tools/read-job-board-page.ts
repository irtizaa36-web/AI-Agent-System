import type { Tool } from "./tool";
import type { BrowserClient } from "../integrations/browser/client";

interface ReadJobBoardPageInput {
  readonly url: string;
}

function isReadJobBoardPageInput(input: unknown): input is ReadJobBoardPageInput {
  return typeof input === "object" && input !== null && typeof (input as { url?: unknown }).url === "string";
}

/**
 * Reads the rendered visible text of a public job-board search results
 * page (ADR 0012) — no login required, unlike read-web-page's Sermo
 * session. Read-only, same as read-web-page; this Tool has no way to
 * click, apply to, or save a job listing.
 */
export function createReadJobBoardPageTool(browserClient: BrowserClient): Tool {
  return {
    name: "read-job-board-page",
    description:
      "Reads the rendered visible text of a public job-board search results page (e.g. a job search URL with location/keyword filters already applied). Read-only: there is no way for this tool to click, apply, or save a listing.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    async execute(input: unknown): Promise<string> {
      if (!isReadJobBoardPageInput(input)) {
        throw new Error('read-job-board-page tool requires an input of the shape { "url": string }');
      }
      return browserClient.getPageText(input.url);
    },
  };
}
