import type { Tool } from "./tool";
import type { BrowserClient } from "../integrations/browser/client";
import { runXSearchSweep, type XSearchSweepOptions } from "../integrations/x-research/sweep";

/**
 * Runs the standing X/Twitter topic search sweep (ADR 0025) through the
 * logged-in @WoozyBets browser session and returns a structured report:
 * each topic's rendered search-results text, or a "blocked"/"skipped"
 * status when the session or that topic's pages came back blank. Read-only,
 * same structural guarantee as read-web-page — BrowserClient has no
 * click/type/submit/follow/like/reply/DM operation for this Tool to expose
 * even if an agent were instructed to use one.
 */
export function createXSearchSweepTool(browserClient: BrowserClient, sweepOptions: XSearchSweepOptions = {}): Tool {
  return {
    name: "x-search-sweep",
    description:
      "Runs the standing X search-intel sweep (NFL betting, college football betting, NBA, UFC/MMA, soccer, tech/AI, stocks, Houston) through the logged-in @WoozyBets session and returns each topic's rendered search-results text, or a clear blocked/skipped status when the session or that topic is blank. Read-only: there is no way for this tool to like, reply, repost, follow, or DM.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute(): Promise<string> {
      const sweep = await runXSearchSweep(browserClient, sweepOptions);
      return JSON.stringify(sweep, null, 2);
    },
  };
}
