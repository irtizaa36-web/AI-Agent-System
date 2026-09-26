import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { browserSessionPath } from "../integrations/browser/session";
import type { BrowserClient } from "../integrations/browser/client";
import { checkSessionHealth } from "../integrations/browser/page-health";
import { createBrowserClientFromSession, createPublicBrowserClient } from "../integrations/browser/real-client";
import type { CliDeps } from "./index";

/**
 * `browser login <site> <url>`: opens a real, visible browser window so a
 * human can log in themselves (ADR 0007) — this project never types a
 * password on anyone's behalf. Waits for the person to press Enter back
 * here once they're logged in, then saves the authenticated session for
 * `getPageText` to reuse.
 */
async function loginCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const [site, url] = args;
  if (!site || !url) {
    deps.stderr("Usage: orchestrator browser login <site> <url>");
    return 1;
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url);

    deps.stdout(`A browser window has opened to ${url}.`);
    deps.stdout(`Log in to "${site}" manually in that window (including any 2FA), then come back here.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Press Enter once you're logged in... ");
    rl.close();

    const path = browserSessionPath(site);
    await mkdir(dirname(path), { recursive: true });
    await context.storageState({ path });
    deps.stdout(`Saved the authenticated session for "${site}" to ${path}.`);
    return 0;
  } finally {
    await browser.close();
  }
}

/** Uses the saved session for `site` when there is one, otherwise a plain public browser — never a fake, so a health check can't pass on canned text. */
function defaultHealthClient(site: string): BrowserClient {
  return createBrowserClientFromSession(site) ?? createPublicBrowserClient(site);
}

/**
 * `browser health <site> <url>`: one read-only load of `url` with the
 * site's session, classified per ADR 0026. Prints `status: ok|empty|blocked|error`
 * and exits non-zero unless the page really loaded, so a script can gate
 * a sweep or pipeline run on it. One request, no retry.
 */
async function healthCommand(args: readonly string[], deps: CliDeps, clientFor: (site: string) => BrowserClient): Promise<number> {
  const [site, url] = args;
  if (!site || !url) {
    deps.stderr("Usage: orchestrator browser health <site> <url>");
    return 1;
  }
  const health = await checkSessionHealth(clientFor(site), url);
  deps.stdout(`status: ${health.status}`);
  deps.stdout(health.note);
  return health.healthy ? 0 : 1;
}

export async function runBrowserCommand(
  args: readonly string[],
  deps: CliDeps,
  clientFor: (site: string) => BrowserClient = defaultHealthClient,
): Promise<number> {
  const [subcommand, ...rest] = args;

  if (subcommand === "login") {
    return loginCommand(rest, deps);
  }
  if (subcommand === "health") {
    return healthCommand(rest, deps, clientFor);
  }

  deps.stderr("Usage: orchestrator browser login <site> <url> | orchestrator browser health <site> <url>");
  return 1;
}
