import { realGitRunner, type GitRunner } from "../integrations/git/auto-commit";

/**
 * Prepares a local working branch for a picked-up brief, entirely via
 * local `git` — never GitHub's write API (see client.ts's own comment on
 * why). If the target branch already exists on `origin` (a previous
 * partial pickup, or a Code session that already pushed to it), that
 * branch is checked out as-is rather than reset. Otherwise a fresh branch
 * is created off `origin/<baseBranch>`, mirroring how a Code session
 * starts any task branch per PROTOCOL.md.
 */
export interface CheckoutResult {
  readonly ok: boolean;
  readonly branch: string;
  /** True when the branch didn't already exist on `origin` and was created fresh off the base branch. */
  readonly createdNew: boolean;
  readonly error?: string;
}

export function prepareWorkingBranch(
  targetBranch: string,
  baseBranch: string,
  cwd: string,
  runner: GitRunner = realGitRunner,
): CheckoutResult {
  const fetchBase = runner(["fetch", "origin", baseBranch], cwd);
  if (fetchBase.status !== 0) {
    return { ok: false, branch: targetBranch, createdNew: false, error: `git fetch origin ${baseBranch} failed: ${fetchBase.stderr.trim()}` };
  }

  // A non-existent remote branch makes this fail — that failure is expected and not fatal, it's how we tell "new branch" from "existing branch".
  const fetchTarget = runner(["fetch", "origin", targetBranch], cwd);
  const remoteTargetExists = fetchTarget.status === 0;

  const base = remoteTargetExists ? `origin/${targetBranch}` : `origin/${baseBranch}`;
  const checkout = runner(["checkout", "-B", targetBranch, base], cwd);
  if (checkout.status !== 0) {
    return { ok: false, branch: targetBranch, createdNew: !remoteTargetExists, error: `git checkout -B ${targetBranch} ${base} failed: ${checkout.stderr.trim()}` };
  }

  return { ok: true, branch: targetBranch, createdNew: !remoteTargetExists };
}
