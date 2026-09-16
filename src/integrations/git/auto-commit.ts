import { spawnSync } from "node:child_process";

/**
 * The one place this project commits and pushes on its own, without a human
 * typing the command. That's worth being blunt about: everywhere else in
 * this repo (see the CLAUDE.md this session runs under), git push is a
 * human-approved action. This exists specifically because the feedback
 * loop (feedback.ts) needs it — Shivani's replies auto-adjusting her own
 * preferences.json, per Irtiza's explicit Sep 16 call for no approval step
 * on that flow — and because the scheduled pipeline run
 * (scripts/com.mobyai.jobsearch.plist) never runs `git pull` first, it just
 * reads whatever's on disk. A change that's applied to the file but never
 * committed survives until the next `git pull` silently overwrites it, or a
 * re-clone silently loses it outright — either way, exactly the kind of
 * quiet breakage this project has already spent real time chasing down
 * once (the title-matching bug, the alert-mail body bug). Committing makes
 * it durable and visible in `git log`; pushing makes it survive a re-clone.
 */

export interface GitCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injected so tests can assert on exact git invocations without ever running real git. */
export type GitRunner = (args: readonly string[], cwd: string) => GitCommandResult;

export const realGitRunner: GitRunner = (args, cwd) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

export interface CommitAndPushResult {
  readonly committed: boolean;
  readonly pushed: boolean;
  /** True when git add+diff found nothing to commit — not an error, just nothing to do (e.g. the patch set a field to the value it already had). */
  readonly noChange?: boolean;
  readonly error?: string;
}

/**
 * Stages exactly one file, commits it if — and only if — that staging
 * actually changed something, then pushes. `git diff --cached --quiet`
 * (exit 0 = no staged changes) is the check that keeps a no-op patch from
 * producing an empty commit, the same "no empty commits" rule this
 * project's own PR-driving rules already hold everywhere else.
 */
export function commitAndPush(filePath: string, message: string, cwd: string, runner: GitRunner = realGitRunner): CommitAndPushResult {
  const add = runner(["add", filePath], cwd);
  if (add.status !== 0) return { committed: false, pushed: false, error: `git add failed: ${add.stderr.trim()}` };

  const diff = runner(["diff", "--cached", "--quiet", "--", filePath], cwd);
  if (diff.status === 0) return { committed: false, pushed: false, noChange: true };

  const commit = runner(["commit", "-m", message, "--", filePath], cwd);
  if (commit.status !== 0) return { committed: false, pushed: false, error: `git commit failed: ${commit.stderr.trim()}` };

  const push = runner(["push"], cwd);
  if (push.status !== 0) return { committed: true, pushed: false, error: `git push failed: ${push.stderr.trim()}` };

  return { committed: true, pushed: true };
}
