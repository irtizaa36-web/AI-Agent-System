import { join } from "node:path";
import { parseArgs } from "node:util";
import { createGitHubClientFromEnv } from "../integrations/github/real-client";
import { JsonFileSeenBriefStore } from "../watcher/seen-store";
import { prepareWorkingBranch } from "../watcher/checkout";
import { writePickupStub } from "../watcher/delegation-log-stub";
import { pollForBriefs, DEFAULT_BASE_BRANCH, type PollResult } from "../watcher/brief-watcher";

export interface WatchBriefsDeps {
  readonly cwd: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

const DEFAULT_INTERVAL_MS = 180_000; // roughly 3 minutes, matching Muse's watcher cadence (PROTOCOL.md)

/** Builds the real, single-poll pipeline from environment + local git — the one path that isn't exercised in tests (see brief-watcher.test.ts for the tested core logic against a fake GitHub client). */
export async function pollOnce(deps: WatchBriefsDeps): Promise<PollResult> {
  const github = createGitHubClientFromEnv();
  const seenStore = new JsonFileSeenBriefStore(join(deps.cwd, ".orchestrator", "watcher", "seen"));
  const baseBranch = process.env.GITHUB_BASE_BRANCH ?? DEFAULT_BASE_BRANCH;

  return pollForBriefs({
    github,
    seenStore,
    checkoutBranch: (targetBranch) => {
      const result = prepareWorkingBranch(targetBranch, baseBranch, deps.cwd);
      return { ok: result.ok, error: result.error };
    },
    recordPickup: async (brief, sourceBranch, sourcePath) => {
      const result = await writePickupStub(brief, sourceBranch, sourcePath, deps.cwd);
      return { ok: (result.committed && result.pushed) || result.noChange === true, error: result.error };
    },
  });
}

function reportPollResult(result: PollResult, deps: WatchBriefsDeps): number {
  deps.stdout(`Scanned ${result.scannedBranches.length} claude/* branch(es).`);

  if (result.pickups.length === 0 && result.parseErrors.length === 0) {
    deps.stdout("No new briefs found.");
    return 0;
  }

  let hadError = false;
  for (const pickup of result.pickups) {
    if (pickup.checkedOut && pickup.logWritten) {
      deps.stdout(`Picked up "${pickup.brief.title}" from ${pickup.sourceBranch}:${pickup.sourcePath} -> checked out ${pickup.brief.targetBranch}, delegation log pushed.`);
    } else if (pickup.checkedOut) {
      hadError = true;
      deps.stdout(`Picked up "${pickup.brief.title}" -> checked out ${pickup.brief.targetBranch}, but the delegation-log push failed: ${pickup.error}`);
    } else {
      hadError = true;
      deps.stdout(`Found "${pickup.brief.title}" but could not check out ${pickup.brief.targetBranch}: ${pickup.error}. Will retry next poll.`);
    }
  }

  for (const parseError of result.parseErrors) {
    hadError = true;
    deps.stderr(`Malformed brief at ${parseError.sourceBranch}:${parseError.sourcePath}: ${parseError.error}`);
  }

  return hadError ? 1 : 0;
}

async function runPoll(deps: WatchBriefsDeps): Promise<number> {
  try {
    const result = await pollOnce(deps);
    return reportPollResult(result, deps);
  } catch (error) {
    deps.stderr(`watch-briefs poll failed: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * Repeats `poll` every `intervalMs`, forever unless `iterations` caps it
 * (test-only knob — real usage never sets it). One poll failing is logged
 * and the loop keeps going, per PROTOCOL.md's "back off, don't hammer" —
 * a bad poll waits out the same interval rather than retrying immediately.
 */
export async function runLoop(
  poll: () => Promise<number>,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
  log: (line: string) => void,
  iterations = Number.POSITIVE_INFINITY,
): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    if (i > 0) await sleep(intervalMs);
    try {
      await poll();
    } catch (error) {
      log(`watch-briefs loop: poll threw unexpectedly: ${(error as Error).message}`);
    }
  }
}

export async function runWatchBriefsCommand(args: readonly string[], deps: WatchBriefsDeps): Promise<number> {
  const [subcommand, ...rest] = args;

  if (subcommand === "poll") {
    return runPoll(deps);
  }

  if (subcommand === "loop") {
    let intervalMs = DEFAULT_INTERVAL_MS;
    try {
      const parsed = parseArgs({ args: [...rest], options: { "interval-ms": { type: "string" } } });
      if (parsed.values["interval-ms"]) intervalMs = Number(parsed.values["interval-ms"]);
    } catch (error) {
      deps.stderr(`Invalid arguments: ${(error as Error).message}`);
      return 1;
    }
    deps.stdout(`Polling every ${intervalMs}ms. Press Ctrl+C to stop.`);
    await runLoop(
      () => runPoll(deps),
      intervalMs,
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      deps.stderr,
    );
    return 0;
  }

  deps.stderr("Usage: orchestrator watch-briefs poll | orchestrator watch-briefs loop [--interval-ms N]");
  return 1;
}
