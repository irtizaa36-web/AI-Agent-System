import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Where `browser login <site>` saves a session, and where the real client
 * reads it back from. Gitignored (see .gitignore) like every other local
 * credential/session file in this project.
 */
export function browserSessionPath(siteName: string): string {
  return join(".orchestrator", "browser-sessions", `${siteName}.json`);
}

export function hasBrowserSession(siteName: string): boolean {
  return existsSync(browserSessionPath(siteName));
}
