import type { GitHubClient } from "../integrations/github/client";
import { parseBrief, type Brief } from "./brief";
import { briefSeenKey, type SeenBriefStore } from "./seen-store";

export const DEFAULT_BRANCH_PREFIX = "claude/";
export const DEFAULT_BRIEFS_DIR = "docs/delegation/briefs";
export const DEFAULT_BASE_BRANCH = "main";

export interface CheckoutOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

export interface RecordPickupOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

export interface BriefPickup {
  readonly brief: Brief;
  readonly sourceBranch: string;
  readonly sourcePath: string;
  readonly checkedOut: boolean;
  readonly logWritten: boolean;
  readonly error?: string;
}

export interface BriefParseError {
  readonly sourceBranch: string;
  readonly sourcePath: string;
  readonly error: string;
}

export interface PollResult {
  readonly scannedBranches: readonly string[];
  readonly pickups: readonly BriefPickup[];
  readonly parseErrors: readonly BriefParseError[];
}

export interface BriefWatcherDeps {
  readonly github: GitHubClient;
  readonly seenStore: SeenBriefStore;
  readonly branchPrefix?: string;
  readonly briefsDir?: string;
  /** Prepares (or reuses) a local working branch for the brief's target branch. Never GitHub's write API — see checkout.ts. */
  readonly checkoutBranch: (targetBranch: string) => CheckoutOutcome | Promise<CheckoutOutcome>;
  /** Writes the starter delegation-log stub into the now-checked-out working tree and pushes it — see delegation-log-stub.ts. */
  readonly recordPickup: (brief: Brief, sourceBranch: string, sourcePath: string) => RecordPickupOutcome | Promise<RecordPickupOutcome>;
}

/**
 * One poll cycle (ADR 0027): list `claude/*` branches, list each one's
 * `docs/delegation/briefs/` directory, and for every `.md` file not
 * already seen, parse it, check out its target branch, and write a
 * starter delegation-log entry there. Never merges, never touches
 * anything outside the target branch it just prepared — the merge-on-
 * green-only rule and every approval gate in PROTOCOL.md stay exactly as
 * they are. One bad branch or one malformed brief never stops the rest of
 * the poll from running.
 */
export async function pollForBriefs(deps: BriefWatcherDeps): Promise<PollResult> {
  const branchPrefix = deps.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  const briefsDir = deps.briefsDir ?? DEFAULT_BRIEFS_DIR;

  const pickups: BriefPickup[] = [];
  const parseErrors: BriefParseError[] = [];
  const scannedBranches = await deps.github.listBranches(branchPrefix);

  for (const branch of scannedBranches) {
    const entries = await deps.github.listDirectory(branch, briefsDir);
    for (const entry of entries) {
      if (entry.type !== "file" || !entry.path.endsWith(".md")) continue;

      const key = briefSeenKey(branch, entry.path, entry.sha);
      if (await deps.seenStore.has(key)) continue;

      const content = await deps.github.getFileContent(branch, entry.path);
      if (content === undefined) continue; // vanished between listing and reading — nothing to pick up this poll

      const parsed = parseBrief(content);
      if (!parsed.ok) {
        parseErrors.push({ sourceBranch: branch, sourcePath: entry.path, error: parsed.error });
        await deps.seenStore.markSeen(key); // don't re-report the same malformed content on every poll
        continue;
      }

      const checkout = await deps.checkoutBranch(parsed.brief.targetBranch);
      if (!checkout.ok) {
        // Left unseen on purpose: a checkout failure (network blip, transient git error) is worth retrying next poll.
        pickups.push({ brief: parsed.brief, sourceBranch: branch, sourcePath: entry.path, checkedOut: false, logWritten: false, error: checkout.error });
        continue;
      }

      const recorded = await deps.recordPickup(parsed.brief, branch, entry.path);
      pickups.push({
        brief: parsed.brief,
        sourceBranch: branch,
        sourcePath: entry.path,
        checkedOut: true,
        logWritten: recorded.ok,
        error: recorded.error,
      });
      await deps.seenStore.markSeen(key);
    }
  }

  return { scannedBranches, pickups, parseErrors };
}
