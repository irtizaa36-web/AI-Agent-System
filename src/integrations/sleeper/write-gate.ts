import type { PlayerMap, SleeperRoster } from "./client";
import { buildWritePlan, checkAgainstRosters, describeWrite, type SleeperWriteAction, type WritePlan } from "./write-actions";

/**
 * The write gate (ADR 0021). Every Sleeper write goes through
 * `runSleeperWrite`, and it sends nothing unless `confirm` is exactly `true`.
 * Without it the call is a dry run: it returns the preview (plain-English
 * effects, roster problems, and the exact GraphQL operation) and never
 * touches the write client. With it, the preview is rebuilt from the same
 * input, the roster check is re-run, and only a clean action is sent.
 */

/** Sends one GraphQL operation to Sleeper with the owner's session. Only graphql-client.ts implements this for real. */
export interface SleeperWriteClient {
  execute(plan: WritePlan): Promise<unknown>;
}

export interface WritePreview {
  readonly action: SleeperWriteAction;
  readonly effects: readonly string[];
  /** Problems found against live rosters; a non-empty list blocks execution. Undefined when rosters weren't checked. */
  readonly problems: readonly string[] | undefined;
  readonly plan: WritePlan;
}

export type WriteOutcome =
  | { readonly dryRun: true; readonly written: false; readonly preview: WritePreview }
  | { readonly dryRun: false; readonly written: true; readonly preview: WritePreview; readonly result: unknown };

export const NOT_CONFIGURED =
  "Sleeper writes are not configured: set SLEEPER_TOKEN (your own Sleeper session token) in .env. Read-only features work without it.";

export function previewWrite(action: SleeperWriteAction, context: { readonly rosters?: readonly SleeperRoster[]; readonly players?: PlayerMap } = {}): WritePreview {
  return {
    action,
    effects: describeWrite(action, context.players),
    problems: context.rosters ? checkAgainstRosters(action, context.rosters) : undefined,
    plan: buildWritePlan(action),
  };
}

export function formatPreview(preview: WritePreview): string {
  return [
    "dry_run:true",
    "written:false",
    `kind:${preview.action.kind}`,
    `leagueId:${preview.action.leagueId}`,
    "effects:",
    ...preview.effects.map((line) => `  - ${line}`),
    preview.problems === undefined
      ? "rosterCheck:skipped"
      : preview.problems.length === 0
        ? "rosterCheck:ok"
        : ["rosterCheck:FAILED", ...preview.problems.map((p) => `  - ${p}`)].join("\n"),
    `graphqlOperation:${preview.plan.operation}`,
    `graphqlVariables:${JSON.stringify(preview.plan.variables)}`,
  ].join("\n");
}

export interface RunWriteOptions {
  /** Must be exactly `true` to send. Anything else (missing, "true", 1) is a dry run. */
  readonly confirm?: unknown;
  readonly client?: SleeperWriteClient;
  /** Live rosters for the league. Required to execute: a write is never sent unchecked. */
  readonly rosters?: readonly SleeperRoster[];
  readonly players?: PlayerMap;
}

export async function runSleeperWrite(action: SleeperWriteAction, options: RunWriteOptions): Promise<WriteOutcome> {
  const preview = previewWrite(action, { ...(options.rosters ? { rosters: options.rosters } : {}), ...(options.players ? { players: options.players } : {}) });
  if (options.confirm !== true) return { dryRun: true, written: false, preview };

  if (!options.client) throw new Error(NOT_CONFIGURED);
  if (preview.problems === undefined) throw new Error("Refusing to write: the action was not checked against the league's live rosters.");
  if (preview.problems.length > 0) throw new Error(`Refusing to write: ${preview.problems.join("; ")}`);

  const result = await options.client.execute(preview.plan);
  return { dryRun: false, written: true, preview, result };
}
