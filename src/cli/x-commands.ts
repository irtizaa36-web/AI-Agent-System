import { runXSearchSweep, type XSearchSweepOptions, type XSearchSweepResult } from "../integrations/x-research/sweep";
import { createDefaultBrowserClient } from "../config/load";
import type { BrowserClient } from "../integrations/browser/client";
import type { CliDeps } from "./index";

function formatSweep(sweep: XSearchSweepResult): string {
  const lines: string[] = [];
  if (!sweep.sessionHealthy) {
    lines.push("SESSION UNHEALTHY — the @WoozyBets browser session failed its pre-sweep health check. No topic was attempted.");
  }
  for (const result of sweep.results) {
    lines.push("");
    lines.push(`## ${result.topic} [${result.status}]`);
    if (result.note) lines.push(result.note);
    if (result.text) lines.push(result.text);
  }
  return lines.join("\n");
}

/**
 * `orchestrator x search-sweep`: runs the standing X search-intel sweep
 * (ADR 0025) directly from the CLI, so the X Search Intel skill can call a
 * tested, retry/backoff/circuit-breaker-aware path instead of spawning an
 * untested ad hoc browser task per topic. Exits non-zero when the session
 * health check failed, so a caller (human or skill) notices immediately
 * rather than having to parse the report to find out.
 */
export async function runXCommand(
  args: readonly string[],
  deps: CliDeps,
  browserClient: BrowserClient = createDefaultBrowserClient("x"),
  sweepOptions: XSearchSweepOptions = {},
): Promise<number> {
  const [subcommand] = args;

  if (subcommand === "search-sweep") {
    const sweep = await runXSearchSweep(browserClient, sweepOptions);
    deps.stdout(formatSweep(sweep));
    return sweep.sessionHealthy ? 0 : 1;
  }

  deps.stderr("Usage: orchestrator x search-sweep");
  return 1;
}
