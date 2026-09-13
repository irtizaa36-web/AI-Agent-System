import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPipeline } from "../jobsearch/pipeline";
import { renderDigest, digestPayload } from "../jobsearch/digest";
import { sourcesFromWatchlist } from "../jobsearch/sources/registry";
import { JsonFileJobStore } from "../store/job-store";
import { createScoringClientFromEnv } from "../jobsearch/scoring-client";
import { readLedger } from "../jobsearch/cost";
import { createJobsDashboardServer } from "../jobsearch/dashboard";
import {
  COST_LOG_PATH,
  DATA_DIR,
  loadPreferences,
  loadProfile,
  loadWatchlist,
  MissingProfileError,
} from "../jobsearch/config";
import type { CandidateProfile } from "../jobsearch/score";

/**
 * `orchestrator jobs ...` — the pipeline's command surface, and the single
 * entrypoint the scheduled run invokes. Nothing here is interactive: a
 * launchd job runs `jobs run` and everything it needs comes from config files
 * and the environment.
 */

export interface JobsCommandDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly root?: string;
}

const USAGE = [
  "jobs subcommands:",
  "  run              Fetch, dedupe, filter, score, and write today's digest",
  "  digest           Print the most recent digest without running the pipeline",
  "  sources          List the configured sources and check each one's health",
  "  costs            Show what recent runs have cost",
  "  dashboard        Serve the local review queue (default port 8899)",
].join("\n");

export async function runJobsCommand(args: readonly string[], deps: JobsCommandDeps): Promise<number> {
  const root = deps.root ?? ".";
  const [subcommand] = args;

  switch (subcommand) {
    case "run":
      return runJobsRun(root, deps);
    case "digest":
      return printLatestDigest(root, deps);
    case "sources":
      return listSources(root, deps);
    case "costs":
      return printCosts(root, deps);
    case "dashboard":
      return serveDashboard(args.slice(1), root, deps);
    default:
      deps.stdout(USAGE);
      return subcommand === undefined || subcommand === "help" ? 0 : 1;
  }
}

async function runJobsRun(root: string, deps: JobsCommandDeps): Promise<number> {
  const prefs = await loadPreferences(root);
  const watchlist = await loadWatchlist(root);

  if (watchlist.length === 0) {
    deps.stderr("No sources configured. Add companies to config/job-search/watchlist.json and run again.");
    return 1;
  }

  // A missing resume stops scoring, not the run: discovery and filtering are
  // still worth doing, and the digest says plainly why nothing was scored.
  let profile: CandidateProfile = { resume: "", notes: "" };
  let profileMissing: string | null = null;
  try {
    profile = await loadProfile(root);
  } catch (error) {
    if (error instanceof MissingProfileError) {
      profileMissing = error.message;
    } else {
      throw error;
    }
  }

  const scoringClient = profileMissing ? undefined : createScoringClientFromEnv();
  if (!profileMissing && !scoringClient) {
    deps.stderr("ANTHROPIC_API_KEY is not set — running discovery only, scoring will be skipped.");
  }
  if (profileMissing) deps.stderr(profileMissing);

  const summary = await runPipeline({
    sources: sourcesFromWatchlist(watchlist),
    store: new JsonFileJobStore(join(root, DATA_DIR)),
    prefs,
    profile,
    scoringClient,
    costLogPath: join(root, COST_LOG_PATH),
  });

  const markdown = renderDigest(summary);
  const digestDir = join(root, DATA_DIR, "digests");
  await mkdir(digestDir, { recursive: true });
  const stamp = summary.startedAt.replace(/[:.]/g, "-");
  await writeFile(join(digestDir, `${stamp}.md`), markdown, "utf8");
  await writeFile(join(digestDir, "latest.md"), markdown, "utf8");
  await writeFile(join(digestDir, "latest.json"), JSON.stringify(digestPayload(summary), null, 2), "utf8");

  deps.stdout(markdown);
  deps.stdout("");
  deps.stdout(`Digest written to ${join(digestDir, "latest.md")}`);

  // A run where every source broke is a failure worth a non-zero exit, so a
  // scheduled job surfaces it rather than looking like a quiet success.
  const allBroken = summary.health.length > 0 && summary.health.every((entry) => entry.state === "degraded");
  return allBroken ? 1 : 0;
}

async function printLatestDigest(root: string, deps: JobsCommandDeps): Promise<number> {
  const { readFile } = await import("node:fs/promises");
  try {
    deps.stdout(await readFile(join(root, DATA_DIR, "digests", "latest.md"), "utf8"));
    return 0;
  } catch {
    deps.stderr("No digest yet. Run `orchestrator jobs run` first.");
    return 1;
  }
}

async function listSources(root: string, deps: JobsCommandDeps): Promise<number> {
  const watchlist = await loadWatchlist(root);
  if (watchlist.length === 0) {
    deps.stderr("No sources configured in config/job-search/watchlist.json.");
    return 1;
  }

  deps.stdout(`${watchlist.length} source(s) configured. Checking each...`);
  const sources = sourcesFromWatchlist(watchlist);
  let broken = 0;

  for (const source of sources) {
    try {
      const postings = await source.fetch();
      deps.stdout(`  ok        ${source.id} — ${postings.length} posting(s)`);
    } catch (error) {
      broken += 1;
      deps.stdout(`  BROKEN    ${source.id} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return broken > 0 ? 1 : 0;
}

async function printCosts(root: string, deps: JobsCommandDeps): Promise<number> {
  const entries = await readLedger(join(root, COST_LOG_PATH));
  if (entries.length === 0) {
    deps.stdout("No model spend recorded yet.");
    return 0;
  }

  const byRun = new Map<string, { cost: number; ts: string }>();
  for (const entry of entries) {
    const current = byRun.get(entry.runId) ?? { cost: 0, ts: entry.ts };
    byRun.set(entry.runId, { cost: current.cost + entry.costUsd, ts: current.ts });
  }

  const runs = [...byRun.entries()].sort((left, right) => left[1].ts.localeCompare(right[1].ts));
  for (const [runId, run] of runs.slice(-20)) {
    deps.stdout(`  ${run.ts.slice(0, 16).replace("T", " ")}  $${run.cost.toFixed(4)}  ${runId.slice(0, 8)}`);
  }

  const total = runs.reduce((sum, [, run]) => sum + run.cost, 0);
  deps.stdout("");
  deps.stdout(`${runs.length} run(s), $${total.toFixed(2)} total.`);
  return 0;
}

/** Serves the review queue. Read-only: no endpoint here can act on the outside world. */
async function serveDashboard(args: readonly string[], root: string, deps: JobsCommandDeps): Promise<number> {
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number.parseInt(args[portIndex + 1] ?? "", 10) : 8899;
  if (!Number.isFinite(port) || port <= 0) {
    deps.stderr("--port must be a positive number.");
    return 1;
  }

  const server = createJobsDashboardServer({ dataDir: join(root, DATA_DIR) });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  deps.stdout(`Job queue: http://localhost:${port}  (ctrl-c to stop)`);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
