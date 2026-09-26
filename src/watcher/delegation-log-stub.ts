import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { commitAndPush, realGitRunner, type GitRunner } from "../integrations/git/auto-commit";
import type { Brief } from "./brief";

export const DELEGATION_LOG_PATH = "trial/delegation-log.md";

/**
 * A starter `trial/delegation-log.md` for the Code session that picks up
 * this branch next — not a finished log. PROTOCOL.md's format (diagnosis,
 * delegation table, budget status) is left as fill-in-the-blank headings
 * rather than guessed content, per the "never invent results" hard rule:
 * the watcher observed a brief and checked out a branch, nothing more.
 */
export function renderPickupStub(brief: Brief, sourceBranch: string, sourcePath: string, pickedUpAt: string): string {
  return [
    `# Delegation log: ${brief.title}`,
    "",
    `Branch: \`${brief.targetBranch}\``,
    `Picked up by: the orchestrator brief watcher (ADR 0027), from \`${sourceBranch}:${sourcePath}\` at ${pickedUpAt}.`,
    "Protocol: `docs/delegation/PROTOCOL.md`",
    "",
    "## Brief",
    "",
    brief.body.length > 0 ? brief.body : "_(the brief had no body)_",
    "",
    "## Diagnosis",
    "",
    "_Fill in once work starts._",
    "",
    "## Delegation table",
    "",
    "| Subtask | Disposition | Reasoning |",
    "|---|---|---|",
    "",
    "## Budget status (at write-up)",
    "",
    "_Fill in before opening the PR._",
    "",
  ].join("\n");
}

export interface WritePickupStubResult {
  readonly committed: boolean;
  readonly pushed: boolean;
  readonly noChange?: boolean;
  readonly error?: string;
}

/** Writes the stub into a checked-out working tree at `cwd` and commits+pushes it — the one piece of the watcher that writes anything back to GitHub, and it does so as an ordinary commit on the brief's own target branch, not through the GitHub API. */
export async function writePickupStub(
  brief: Brief,
  sourceBranch: string,
  sourcePath: string,
  cwd: string,
  runner: GitRunner = realGitRunner,
  now: () => string = () => new Date().toISOString(),
): Promise<WritePickupStubResult> {
  const content = renderPickupStub(brief, sourceBranch, sourcePath, now());
  const fullPath = join(cwd, DELEGATION_LOG_PATH);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
  const result = commitAndPush(DELEGATION_LOG_PATH, `watcher: pick up brief "${brief.title}"`, cwd, runner);
  return { committed: result.committed, pushed: result.pushed, noChange: result.noChange, error: result.error };
}
