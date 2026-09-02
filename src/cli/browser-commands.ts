import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { browserSessionPath } from "../integrations/browser/session";
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

export async function runBrowserCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const [subcommand, ...rest] = args;

  if (subcommand === "login") {
    return loginCommand(rest, deps);
  }

  deps.stderr('Usage: orchestrator browser login <site> <url>');
  return 1;
}
