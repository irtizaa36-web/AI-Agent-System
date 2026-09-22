import type { InkboxClient } from "../integrations/inkbox/client";
import { createInkboxClientFromEnv } from "../integrations/inkbox/real-client";
import { createContactClientFromEnv, type ContactClient } from "../integrations/inkbox/contact-client";
import { commitAndPush, type CommitAndPushResult } from "../integrations/git/auto-commit";
import { createScoringClientFromEnv, type ScoringClient } from "../jobsearch/scoring-client";
import { createSmsClientFromEnv, type SmsClient } from "../jobsearch/sms-client";
import { createImessageClientFromEnv, type ImessageClient } from "../jobsearch/imessage-client";

/**
 * What every `jobs` subcommand needs from the outside world, in one place.
 *
 * The CLI passes only stdout/stderr and everything else defaults to the real
 * thing (process.env, clients built from it, real git). Tests pass fakes for
 * `env` and `clients` so no command under test can reach a real mailbox,
 * phone, model, or remote.
 */

export interface JobsClients {
  readonly inkbox: () => InkboxClient | undefined;
  readonly scoring: () => ScoringClient | undefined;
  readonly sms: () => SmsClient | undefined;
  readonly imessage: () => ImessageClient | undefined;
  readonly contacts: () => ContactClient | undefined;
  readonly commitAndPush: (filePath: string, message: string, cwd: string) => CommitAndPushResult;
}

export interface JobsCommandDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly root?: string;
  /** Read for the opt-in gates (FEEDBACK_LOOP_ENABLED, DIGEST_*). Defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults build each client from process.env, returning undefined when unconfigured. */
  readonly clients?: Partial<JobsClients>;
}

export interface JobsContext {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly root: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clients: JobsClients;
}

const REAL_CLIENTS: JobsClients = {
  inkbox: () => createInkboxClientFromEnv(),
  scoring: createScoringClientFromEnv,
  sms: createSmsClientFromEnv,
  imessage: createImessageClientFromEnv,
  contacts: createContactClientFromEnv,
  commitAndPush: (filePath, message, cwd) => commitAndPush(filePath, message, cwd),
};

export function resolveJobsContext(deps: JobsCommandDeps): JobsContext {
  return {
    stdout: deps.stdout,
    stderr: deps.stderr,
    root: deps.root ?? ".",
    env: deps.env ?? process.env,
    clients: { ...REAL_CLIENTS, ...deps.clients },
  };
}
